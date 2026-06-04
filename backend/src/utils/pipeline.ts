import { db } from '../db/index.ts';
import {
  interviewsTable,
  expressionResultsTable,
  voiceResultsTable,
  transcriptSegmentsTable,
  mbtiResultsTable,
  analysisSummaryTable
} from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { extractAudioFromVideo } from './audio.ts';
import { VIDEOS_DIR, AUDIOS_DIR } from './storage.ts';
import { join } from 'node:path';
import fs from 'node:fs';

const AI_SERVICE_BASE_URL = 'http://127.0.0.1:8000';

export async function processInterviewPipeline(interviewId: string, videoFilename: string) {
  let normalizedAudioPath: string | null = null;
  let preprocessInputPath: string | null = null;

  console.log(`🚀 Starting pipeline for Interview ID: ${interviewId}`);

  const videoPath = join(VIDEOS_DIR, videoFilename);
  const audioFilename = `${videoFilename.split('.')[0]}.wav`;
  const audioPath = join(AUDIOS_DIR, audioFilename);

  try {
    // 1. Update status to 'processing'
    await db.update(interviewsTable)
      .set({ status: 'processing', updatedAt: new Date() })
      .where(eq(interviewsTable.id, interviewId));

    // 2. Extract audio
    const hasExtracted = await extractAudioFromVideo(videoPath, audioPath);

    // Determine file paths to send to AI microservice
    // Resilient fallback: if local extraction failed, we send the video path to audio analysis as well
    const expressionInputPath = videoPath;
    preprocessInputPath = hasExtracted ? audioPath : videoPath;

    if (hasExtracted) {
      await db.update(interviewsTable)
        .set({ audioUrl: audioPath, updatedAt: new Date() })
        .where(eq(interviewsTable.id, interviewId));
    }

    console.log('🎬 Calling Preprocess AI service to normalize audio...');
    normalizedAudioPath = preprocessInputPath;
    try {
      const preprocessRes = await fetch(`${AI_SERVICE_BASE_URL}/analyze/preprocess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_path: preprocessInputPath })
      }).then(r => {
        if (!r.ok) throw new Error(`Preprocess AI service returned ${r.status}`);
        return r.json();
      }) as any;
      normalizedAudioPath = preprocessRes.normalized_path;
      console.log(`✅ Preprocessing completed. Normalized WAV: ${normalizedAudioPath}`);
    } catch (err) {
      console.error('⚠️ Preprocess service failed. Falling back to local/original path for subsequent steps:', err);
    }

    console.log('📡 Calling AI Microservices in parallel...');

    // 3. Dispatch parallel AI service calls
    const [exprRes, transRes, audioRes] = await Promise.all([
      fetch(`${AI_SERVICE_BASE_URL}/analyze/expression`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_path: expressionInputPath })
      }).then(r => {
        if (!r.ok) throw new Error(`Expression AI service returned ${r.status}`);
        return r.json();
      }),
      fetch(`${AI_SERVICE_BASE_URL}/analyze/transcript`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_path: normalizedAudioPath })
      }).then(r => {
        if (!r.ok) throw new Error(`Transcript AI service returned ${r.status}`);
        return r.json();
      }),
      fetch(`${AI_SERVICE_BASE_URL}/analyze/audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_path: normalizedAudioPath })
      }).then(r => {
        if (!r.ok) throw new Error(`Audio AI service returned ${r.status}`);
        return r.json();
      })
    ]) as [any[], any[], any];

    console.log('💾 Saving AI analysis results to PostgreSQL...');

    // 4. Save results to respective tables
    if (exprRes.length > 0) {
      await db.insert(expressionResultsTable).values(
        exprRes.map(item => ({
          interviewId,
          timestampSec: item.timestamp_sec,
          emotion: item.emotion,
          confidence: item.confidence
        }))
      );
    }

    if (transRes.length > 0) {
      // Rekaman hanya berisi suara kandidat (tidak ada pewawancara)
      // Semua segmen transkrip langsung ditetapkan sebagai 'candidate'
      await db.insert(transcriptSegmentsTable).values(
        transRes.map((item: any) => ({
          interviewId,
          startTime: item.start_time,
          endTime: item.end_time,
          text: item.text,
          isFiller: item.is_filler,
          fillerType: item.filler_type,
          fillerCount: item.filler_count || 0,
          pauseBeforeSec: item.pause_before_sec || 0,
          speaker: 'candidate',
          speechAct: item.is_filler ? 'filler' : 'statement'
        }))
      );
    }

    if (audioRes.pitch_data.length > 0) {
      await db.insert(voiceResultsTable).values(
        audioRes.pitch_data.map((item: any, index: number) => ({
          interviewId,
          timestampSec: item.timestamp_sec,
          pitchHz: item.pitch_hz,
          intensityDb: item.intensity_db,
          jitter: index === 0 ? audioRes.voice_quality.jitter : null,
          shimmer: index === 0 ? audioRes.voice_quality.shimmer : null,
          hnr: index === 0 ? audioRes.voice_quality.hnr : null,
          audioEmotion: audioRes.audio_emotion[index]?.emotion || null
        }))
      );
    }

    console.log('🧠 Call MBTI Estimation Engine...');

    // 5. Send aggregated data to MBTI service
    const mbtiRes = await fetch(`${AI_SERVICE_BASE_URL}/analyze/mbti`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expression_data: exprRes,
        voice_data: audioRes.pitch_data,
        transcript_data: transRes
      })
    }).then(r => {
      if (!r.ok) throw new Error(`MBTI AI service returned ${r.status}`);
      return r.json();
    }) as any;

    // 6. Save MBTI Result
    await db.insert(mbtiResultsTable).values({
      interviewId,
      predictedType: mbtiRes.predicted_type,
      eScore: mbtiRes.scores.E,
      iScore: mbtiRes.scores.I,
      sScore: mbtiRes.scores.S,
      nScore: mbtiRes.scores.N,
      tScore: mbtiRes.scores.T,
      fScore: mbtiRes.scores.F,
      jScore: mbtiRes.scores.J,
      pScore: mbtiRes.scores.P,
      confidence: mbtiRes.confidence,
      reasoning: mbtiRes.reasoning
    });

    console.log('📊 Calculating Analysis Summary & Scores...');

    // 7. Calculate Aggregated Metrics & Summaries

    // Emotion stability & dominant emotion
    const emotionCounts: Record<string, number> = {};
    exprRes.forEach(item => {
      emotionCounts[item.emotion] = (emotionCounts[item.emotion] || 0) + 1;
    });

    let dominantEmotion = 'neutral';
    let maxCount = 0;
    Object.entries(emotionCounts).forEach(([emo, count]) => {
      if (count > maxCount) {
        maxCount = count;
        dominantEmotion = emo;
      }
    });

    // Stability score (percentage of dominant emotion vs total)
    const emotionStabilityScore = exprRes.length > 0
      ? roundToTwo((maxCount / exprRes.length) * 100)
      : 100;

    // Voice metrics
    const validPitches = audioRes.pitch_data.filter((p: any) => p.pitch_hz > 0);
    const avgPitchHz = validPitches.length > 0
      ? roundToTwo(validPitches.reduce((acc: number, cur: any) => acc + cur.pitch_hz, 0) / validPitches.length)
      : 0;

    // Pitch standard deviation as variation
    const pitchVariation = validPitches.length > 1
      ? roundToTwo(Math.sqrt(validPitches.reduce((acc: number, cur: any) => acc + Math.pow(cur.pitch_hz - avgPitchHz, 2), 0) / (validPitches.length - 1)))
      : 0;

    // Fluency & Fillers — semua segmen = suara kandidat (tidak ada pewawancara)
    const candidateSegments = transRes;
    const fillerCount = candidateSegments.reduce((acc, seg) => acc + (seg.filler_count || 0), 0);

    const totalWordsCount = candidateSegments.reduce((acc, cur) => acc + (cur.text || '').split(/\s+/).filter(Boolean).length, 0);
    const fillerPercentage = totalWordsCount > 0
      ? roundToTwo((fillerCount / totalWordsCount) * 100)
      : 0;

    // Estimated duration from transcripts
    const firstSegment = transRes[0];
    const lastSegment = transRes[transRes.length - 1];
    const estimatedDuration = lastSegment ? lastSegment.end_time - (firstSegment ? firstSegment.start_time : 0) : 10;
    
    // Calculate candidate speaking active duration
    const firstCandidateSeg = candidateSegments[0];
    const lastCandidateSeg = candidateSegments[candidateSegments.length - 1];
    const candidateDuration = lastCandidateSeg 
      ? lastCandidateSeg.end_time - (firstCandidateSeg ? firstCandidateSeg.start_time : 0) 
      : estimatedDuration;
    const candidateDurationMin = candidateDuration / 60;
    const speakingRateWpm = candidateDurationMin > 0 ? roundToTwo(totalWordsCount / candidateDurationMin) : 0;

    // Fetch candidate type to adjust weights and speed thresholds
    const [interview] = await db.select()
      .from(interviewsTable)
      .where(eq(interviewsTable.id, interviewId))
      .limit(1);

    const candidateType = interview?.candidateType || 'intern';

    // Save duration on interview table
    await db.update(interviewsTable)
      .set({ durationSeconds: Math.round(estimatedDuration), updatedAt: new Date() })
      .where(eq(interviewsTable.id, interviewId));

    // Calculate Overall Score (out of 100)
    // Expression Score: % happy or neutral emotions
    const positiveEmotionsCount = exprRes.filter(item => ['happy', 'neutral'].includes(item.emotion)).length;
    const expressionScore = exprRes.length > 0 ? (positiveEmotionsCount / exprRes.length) * 100 : 100;

    // Voice Score: stability based on jitter (lower jitter is better, 0.015 is standard)
    const jitter = audioRes.voice_quality.jitter || 0.015;
    const voiceScore = Math.max(0, Math.min(100, 100 - (jitter * 2000)));

    // Fluency Score: 100 - penalty for filler words
    const fluencyScore = Math.max(0, 100 - (fillerPercentage * 5));

    // Confidence Score: smile ratio + voice intensity
    const smileCount = exprRes.filter(item => item.emotion === 'happy').length;
    const smileRatio = exprRes.length > 0 ? smileCount / exprRes.length : 0.5;
    const meanIntensity = audioRes.pitch_data.reduce((acc: number, cur: any) => acc + cur.intensity_db, 0) / (audioRes.pitch_data.length || 1);
    const intensityScore = Math.max(0, Math.min(100, (meanIntensity / 80) * 100));
    const confidenceScore = roundToTwo((smileRatio * 50) + (intensityScore * 0.5));

    // Calibrate scoring weights based on candidateType (Intern vs Employee)
    let wExpression = 0.25;
    let wVoice = 0.25;
    let wFluency = 0.30;
    let wConfidence = 0.20;

    if (candidateType === 'intern') {
      wExpression = 0.30;  // Enthusiasm & open facial cues are vital for early career
      wVoice = 0.20;       // More lenient on minor vocal tremors/pitch jitters
      wFluency = 0.25;     // More generous regarding filler words
      wConfidence = 0.25;  // Value raw energy, coachability and confidence
    } else if (candidateType === 'employee') {
      wExpression = 0.20;  // Value structured delivery over emotion cues
      wVoice = 0.25;       // Solid, stable vocal presence is expected
      wFluency = 0.35;     // Strong communication fluency is critical
      wConfidence = 0.20;  // Standard solid delivery
    }

    const overallScore = roundToTwo(
      (expressionScore * wExpression) +
      (voiceScore * wVoice) +
      (fluencyScore * wFluency) +
      (confidenceScore * wConfidence)
    );

    // 8. Save Analysis Summary
    await db.insert(analysisSummaryTable).values({
      interviewId,
      dominantEmotion,
      emotionStabilityScore,
      avgPitchHz,
      pitchVariation,
      speakingRateWpm,
      fillerCount,
      fillerPercentage,
      mbtiType: mbtiRes.predicted_type,
      overallScore,
      recommendations: [],
      executiveSummary: mbtiRes.executive_summary
    });

    // 9. Update status to 'completed'
    await db.update(interviewsTable)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(interviewsTable.id, interviewId));

    console.log(`✅ Pipeline successfully completed for Interview ID: ${interviewId}!`);
  } catch (error: any) {
    console.error(`❌ Pipeline failed for Interview ID ${interviewId}:`, error);

    // Update status to 'failed'
    await db.update(interviewsTable)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(interviewsTable.id, interviewId))
      .catch(e => console.error('Failed to set interview status to failed:', e));
  } finally {
    // Clean up temporary normalized WAV file if created
    if (normalizedAudioPath && preprocessInputPath && normalizedAudioPath !== preprocessInputPath) {
      try {
        if (fs.existsSync(normalizedAudioPath)) {
          fs.unlinkSync(normalizedAudioPath);
          console.log(`🗑️ Cleaned up temporary normalized WAV file: ${normalizedAudioPath}`);
        }
      } catch (cleanupErr) {
        console.error(`⚠️ Failed to delete temporary WAV file: ${normalizedAudioPath}`, cleanupErr);
      }
    }
  }
}

function roundToTwo(num: number): number {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}
