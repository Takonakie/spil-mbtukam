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

const AI_SERVICE_BASE_URL = 'http://127.0.0.1:8000';

export async function processInterviewPipeline(interviewId: string, videoFilename: string) {
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
    const audioInputPath = hasExtracted ? audioPath : videoPath;

    if (hasExtracted) {
      await db.update(interviewsTable)
        .set({ audioUrl: audioPath, updatedAt: new Date() })
        .where(eq(interviewsTable.id, interviewId));
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
        body: JSON.stringify({ file_path: audioInputPath })
      }).then(r => {
        if (!r.ok) throw new Error(`Transcript AI service returned ${r.status}`);
        return r.json();
      }),
      fetch(`${AI_SERVICE_BASE_URL}/analyze/audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_path: audioInputPath })
      }).then(r => {
        if (!r.ok) throw new Error(`Audio AI service returned ${r.status}`);
        return r.json();
      })
    ]) as [any[], any[], any];

    // Call Dialogue Flow Classification using LLM (Gemini)
    console.log('🗣️ Calling Dialogue Flow Classification (Pewawancara vs Pelamar)...');
    let dialogueRes = { segments: [] as any[] };
    if (transRes.length > 0) {
      try {
        const mappedSegments = transRes.map((item, index) => ({
          index,
          text: item.text
        }));
        
        const diagFetch = await fetch(`${AI_SERVICE_BASE_URL}/analyze/dialogue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segments: mappedSegments })
        });
        
        if (diagFetch.ok) {
          dialogueRes = await diagFetch.json() as { segments: any[] };
        } else {
          console.warn(`⚠️ Dialogue flow classifier returned status ${diagFetch.status}`);
        }
      } catch (e) {
        console.error('❌ Dialogue flow classifier failed, falling back to heuristics:', e);
      }
    }

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
      await db.insert(transcriptSegmentsTable).values(
        transRes.map((item, index) => {
          const diagInfo = dialogueRes.segments.find((d: any) => d.index === index);
          return {
            interviewId,
            startTime: item.start_time,
            endTime: item.end_time,
            text: item.text,
            isFiller: item.is_filler,
            fillerType: item.filler_type,
            speaker: diagInfo?.speaker || 'candidate',
            speechAct: diagInfo?.speech_act || 'statement'
          };
        })
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

    // Fluency & Fillers (Candidate speech segments only to ignore interviewer questions)
    const candidateSegments = transRes.filter((seg, index) => {
      const diagInfo = dialogueRes.segments.find((d: any) => d.index === index);
      return !diagInfo || diagInfo.speaker === 'candidate';
    });

    const fillerSegments = candidateSegments.filter(seg => seg.is_filler);
    const fillerCount = fillerSegments.length;
    const totalWordsCount = candidateSegments.reduce((acc, cur) => acc + cur.text.split(' ').length, 0);
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

    // Auto-generated recommendations
    const recommendations = [];
    if (fillerPercentage > (candidateType === 'intern' ? 10 : 6)) {
      recommendations.push(`Penggunaan filler words cukup tinggi (${fillerPercentage.toFixed(1)}%). Latih kesadaran berbicara untuk memberikan hening jeda (pause) sejenak daripada menyisipkan filler.`);
    } else {
      recommendations.push("Kelancaran berbicara sangat baik dengan tingkat disfluensi/filler yang rendah.");
    }

    // Custom speaking rate limits
    const minWpm = candidateType === 'intern' ? 100 : 115;
    const maxWpm = candidateType === 'intern' ? 150 : 135;

    if (speakingRateWpm > maxWpm) {
      recommendations.push(`Tempo bicara Anda terlalu cepat (${speakingRateWpm.toFixed(0)} WPM, melebihi batas ideal ${maxWpm} WPM untuk ${candidateType === 'intern' ? 'Magang' : 'Karyawan'}). Cobalah memperlambat agar materi wawancara tersampaikan dengan matang.`);
    } else if (speakingRateWpm < minWpm && speakingRateWpm > 0) {
      recommendations.push(`Tempo bicara tergolong lambat (${speakingRateWpm.toFixed(0)} WPM, di bawah batas ideal ${minWpm} WPM). Anda bisa menaikkan antusiasme vokal agar komunikasi terasa dinamis.`);
    } else {
      recommendations.push(`Kecepatan tempo bicara ideal (${speakingRateWpm.toFixed(0)} WPM), sangat baik untuk mempermudah pemahaman interviewer.`);
    }

    if (jitter > 0.02) {
      recommendations.push("Terdeteksi sedikit ketidakstabilan vokal (jitter tinggi). Latih pernapasan diafragma untuk menunjang suara vokal yang bulat dan mantap.");
    }

    if (dominantEmotion === 'angry' || dominantEmotion === 'sad') {
      recommendations.push("Ekspresi dominan Anda terkesan tegang atau kurang ramah. Cobalah melatih senyum mikro (micro-smiles) agar terlihat lebih terbuka.");
    }

    recommendations.push(`Saran Komunikasi (${mbtiRes.predicted_type}): Sebagai kandidat dengan tipe estimasi ${mbtiRes.predicted_type}, tonjolkan ${mbtiRes.predicted_type.includes('E') ? 'antusiasme alami Anda dengan tetap mendengarkan secara aktif' : 'analisis mendalam Anda dengan penyampaian vokal yang lebih bertenaga'}.`);

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
      recommendations: mbtiRes.recommendations || recommendations
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
  }
}

function roundToTwo(num: number): number {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}
