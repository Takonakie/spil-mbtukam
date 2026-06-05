import os
import sys

# Prepend virtual environment Scripts path so that subprocesses (like Whisper) find ffmpeg.exe natively
scripts_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "venv", "Scripts"))
if os.path.exists(scripts_dir):
    os.environ["PATH"] = scripts_dir + os.pathsep + os.environ["PATH"]

os.environ["TF_USE_LEGACY_KERAS"] = "1"
os.environ["TF_ENABLE_ONEDNN_OPTS"] = "0"

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import time
import random
from dotenv import load_dotenv
# Try loading dotenv from multiple possible locations to maximize compatibility
for path in [
    os.path.join(os.path.dirname(__file__), "..", ".env"),           # ai-services/.env
    os.path.join(os.path.dirname(__file__), "..", "..", ".env"),      # workspace root .env
    os.path.join(os.path.dirname(__file__), "..", "..", "backend", ".env"), # backend/.env
]:
    if os.path.exists(path):
        load_dotenv(dotenv_path=path)
import cv2
import whisper
import parselmouth
import numpy as np
import torch
from deepface import DeepFace

app = FastAPI(title="Interview Analyzer AI Services", version="1.0.0")

class AnalyzeRequest(BaseModel):
    file_path: str

class ExpressionItem(BaseModel):
    timestamp_sec: float
    emotion: str
    confidence: float

class TranscriptSegment(BaseModel):
    start_time: float
    end_time: float
    text: str
    is_filler: bool
    filler_type: Optional[str] = None
    filler_count: int = 0
    pause_before_sec: float = 0.0

class AudioAnalysisResponse(BaseModel):
    pitch_data: List[dict]
    audio_emotion: List[dict]
    voice_quality: dict

class MbtiRequest(BaseModel):
    expression_data: List[dict]
    voice_data: List[dict]
    transcript_data: List[dict]

class MbtiResponse(BaseModel):
    predicted_type: str
    scores: dict
    confidence: float
    reasoning: dict
    recommendations: Optional[List[str]] = None
    executive_summary: Optional[str] = None

# Initialize Whisper model globally on CPU or GPU
print("Loading Whisper model...")
device = "cuda" if torch.cuda.is_available() else "cpu"
try:
    print("Attempting to load Whisper 'medium' model...")
    whisper_model = whisper.load_model("medium", device=device)
except Exception as e:
    print(f"Failed to load Whisper 'medium' model: {e}. Falling back to 'small'...")
    try:
        whisper_model = whisper.load_model("small", device=device)
    except Exception as e2:
        print(f"Failed to load Whisper 'small' model: {e2}. Falling back to 'base'...")
        whisper_model = whisper.load_model("base", device=device)
print(f"Whisper model loaded successfully on {device}!")


@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "timestamp": time.time(),
        "services": {
            "deepface": "production",
            "whisper": "production",
            "parselmouth": "production",
            "mbti_engine": "production"
        }
    }

@app.post("/analyze/expression", response_model=List[ExpressionItem])
def analyze_expression(request: AnalyzeRequest):
    file_path = request.file_path
    results = []
    
    # Open the video file using OpenCV
    cap = cv2.VideoCapture(file_path)
    if not cap.isOpened():
        raise HTTPException(status_code=400, detail=f"Cannot open video file: {file_path}")
        
    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps <= 0:
        fps = 30.0  # Fallback
        
    # Analyze one frame every 0.5 seconds to balance performance & accuracy
    interval_sec = 0.5
    frame_interval = max(1, int(fps * interval_sec))
    
    frame_idx = 0
    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break
            
        if frame_idx % frame_interval == 0:
            timestamp = frame_idx / fps
            try:
                # Analyze using DeepFace with CV2 frame directly
                # enforce_detection=False prevents crashing on frames with no face
                analysis = DeepFace.analyze(
                    img_path=frame, 
                    actions=['emotion'], 
                    enforce_detection=False,
                    detector_backend='opencv'
                )
                
                if isinstance(analysis, list):
                    analysis = analysis[0]
                    
                emotion = analysis.get('dominant_emotion', 'neutral')
                confidence = float(analysis.get('emotion', {}).get(emotion, 100.0)) / 100.0
                
                results.append(ExpressionItem(
                    timestamp_sec=round(timestamp, 2),
                    emotion=emotion,
                    confidence=round(confidence, 2)
                ))
            except Exception as e:
                # Resilient fallback on frame exception
                results.append(ExpressionItem(
                    timestamp_sec=round(timestamp, 2),
                    emotion="neutral",
                    confidence=0.5
                ))
                
        frame_idx += 1
        
    cap.release()
    
    # Return neutral array if video was extremely short or empty
    if not results:
        results.append(ExpressionItem(timestamp_sec=0.0, emotion="neutral", confidence=1.0))
    else:
        # Apply temporal smoothing
        if len(results) > 1:
            # 1. First pass: confidence-weighted voting with sliding window (5 frames = 2.5s)
            first_pass_emotions = []
            for i in range(len(results)):
                window = results[max(0, i-2):min(len(results), i+3)]
                scores = {}
                for item in window:
                    emo = item.emotion
                    weight = item.confidence if item.confidence >= 0.5 else item.confidence * 0.2
                    scores[emo] = scores.get(emo, 0.0) + weight
                best_emo = max(scores, key=scores.get) if scores else "neutral"
                first_pass_emotions.append(best_emo)
                
            # 2. Second pass: enforce minimum transition duration of 1.5s (3 frames)
            runs = []
            current_emo = first_pass_emotions[0]
            start_idx = 0
            for idx in range(1, len(first_pass_emotions)):
                if first_pass_emotions[idx] != current_emo:
                    runs.append({"emotion": current_emo, "start": start_idx, "end": idx})
                    current_emo = first_pass_emotions[idx]
                    start_idx = idx
            runs.append({"emotion": current_emo, "start": start_idx, "end": len(first_pass_emotions)})
            
            # Merge short runs (length < 3 frames / 1.5s)
            smoothed_emotions = list(first_pass_emotions)
            for r_idx, run in enumerate(runs):
                run_len = run["end"] - run["start"]
                if run_len < 3:
                    target_emo = None
                    if r_idx == 0:
                        if r_idx + 1 < len(runs):
                            target_emo = runs[r_idx + 1]["emotion"]
                    elif r_idx == len(runs) - 1:
                        target_emo = runs[r_idx - 1]["emotion"]
                    else:
                        prev_len = runs[r_idx - 1]["end"] - runs[r_idx - 1]["start"]
                        next_len = runs[r_idx + 1]["end"] - runs[r_idx + 1]["start"]
                        if prev_len >= next_len:
                            target_emo = runs[r_idx - 1]["emotion"]
                        else:
                            target_emo = runs[r_idx + 1]["emotion"]
                    if target_emo:
                        for k in range(run["start"], run["end"]):
                            smoothed_emotions[k] = target_emo
                            
            # 3. Update original results with smoothed emotions & compute smoothed confidence
            for idx in range(len(results)):
                results[idx].emotion = smoothed_emotions[idx]
                window = results[max(0, idx-2):min(len(results), idx+3)]
                matching_confs = [w.confidence for w in window if w.emotion == smoothed_emotions[idx]]
                if matching_confs:
                    results[idx].confidence = round(float(np.mean(matching_confs)), 2)
        
    return results

def preprocess_audio(input_path: str) -> str:
    import tempfile
    import subprocess
    import os
    
    # We want a persistent temp file name, but we shouldn't delete it immediately
    temp_wav = tempfile.NamedTemporaryFile(suffix='_normalized.wav', delete=False)
    temp_wav.close()
    
    cmd = [
        'ffmpeg', '-y', '-i', input_path,
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
        '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
        temp_wav.name
    ]
    
    # Hide console window on Windows
    startupinfo = None
    if os.name == 'nt':
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        
    print(f"[Preprocess] Normalizing and preprocessing audio from {input_path} to {temp_wav.name}...")
    subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, startupinfo=startupinfo, check=True)
    return temp_wav.name

def count_and_find_fillers(text: str, fillers_list: list):
    import re
    # Sort fillers by length descending so that multi-word phrases are matched first
    sorted_fillers = sorted(fillers_list, key=len, reverse=True)
    text_lower = text.lower()
    
    matched_fillers = []
    temp_text = text_lower
    for filler in sorted_fillers:
        escaped = re.escape(filler)
        # Use word boundary
        pattern = r'\b' + escaped + r'\b'
        matches = re.findall(pattern, temp_text)
        if matches:
            for m in matches:
                matched_fillers.append(filler)
            temp_text = re.sub(pattern, " [matched] ", temp_text)
            
    return len(matched_fillers), (matched_fillers[0] if matched_fillers else None)

class PreprocessResponse(BaseModel):
    normalized_path: str

@app.post("/analyze/preprocess", response_model=PreprocessResponse)
def analyze_preprocess(request: AnalyzeRequest):
    try:
        normalized_path = preprocess_audio(request.file_path)
        return PreprocessResponse(normalized_path=normalized_path)
    except Exception as e:
        print(f"[Error] Audio preprocessing failed: {e}")
        raise HTTPException(status_code=500, detail=f"Audio preprocessing failed: {str(e)}")

@app.post("/analyze/transcript", response_model=List[TranscriptSegment])
def analyze_transcript(request: AnalyzeRequest):
    file_path = request.file_path
    
    # 1. Normalize/preprocess if needed
    normalized_path = file_path
    if not file_path.lower().endswith('_normalized.wav'):
        try:
            normalized_path = preprocess_audio(file_path)
        except Exception as e:
            print(f"[Warning] Preprocessing failed in transcript analysis: {e}. Using original file.")
            
    indonesian_fillers = ["anu", "ehm", "ehh", "umm", "hmm", "gitu", "kayak", "jadi", "ya kan", "tuh", "nah", "kan", "sih", "kok", "deh",  "eh", "ehem", "em", "emm", "emh", "um", "uhm", "hm"]
    english_fillers = ["um", "uh", "like", "you know", "basically", "actually", "literally", "so", "right", "well"]
    all_fillers = indonesian_fillers + english_fillers
    
    # Biasing decoder toward Indonesian colloquialism, filler words, and tech terminologies (code mixing)
    prompt = "Halo, perkenalkan nama saya... Saya tertarik dengan posisi... Ehem, anu, kayak, jadi gitu, hmm, ya kan, gitu lho, actually, basically, you know. Saya menggunakan React, Node.js, database, backend, frontend, API."
    
    try:
        # Transcribe with natural sentence/clause segmentation, forced to Indonesian language 'id'
        result = whisper_model.transcribe(
            normalized_path, 
            initial_prompt=prompt,
            language="id",
            temperature=0.0,
            compression_ratio_threshold=2.4,
            no_speech_threshold=0.6,
            condition_on_previous_text=True,
            word_timestamps=True
        )
        
        segments = []
        raw_segments = result.get("segments", [])
        prev_end = 0.0
        
        for seg in raw_segments:
            curr_start = float(seg.get("start", 0.0))
            curr_end = float(seg.get("end", 0.0))
            text = seg.get("text", "").strip()
            if not text:
                continue
                
            # Check gap before this segment (≥ 1.5 seconds)
            gap_before = curr_start - prev_end
            if gap_before >= 1.5:
                segments.append(TranscriptSegment(
                    start_time=round(prev_end, 2),
                    end_time=round(curr_start, 2),
                    text="[Jeda]",
                    is_filler=False,
                    filler_type="pause",
                    filler_count=0,
                    pause_before_sec=round(gap_before, 2)
                ))
                
            pause_before = max(0.0, gap_before)
            
            # Count fillers
            f_count, first_f = count_and_find_fillers(text, all_fillers)
            
            # Detect intra-segment pauses (≥ 0.8s) between words
            words = seg.get("words", [])
            intra_segment_pauses = 0
            if len(words) > 1:
                for i in range(1, len(words)):
                    w_prev_end = words[i-1].get("end", 0.0)
                    w_curr_start = words[i].get("start", 0.0)
                    if w_curr_start - w_prev_end >= 0.8:
                        intra_segment_pauses += 1
                        
            is_filler = (f_count > 0)
            
            segments.append(TranscriptSegment(
                start_time=round(curr_start, 2),
                end_time=round(curr_end, 2),
                text=text,
                is_filler=is_filler,
                filler_type=first_f,
                filler_count=f_count,
                pause_before_sec=round(pause_before, 2)
            ))
            
            prev_end = curr_end
            
        if not segments:
            segments.append(TranscriptSegment(
                start_time=0.0,
                end_time=1.0,
                text="[Hening]",
                is_filler=False,
                filler_count=0,
                pause_before_sec=0.0
            ))
            
        return segments
    except Exception as e:
        print(f"Whisper transcription failed: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

@app.post("/analyze/audio", response_model=AudioAnalysisResponse)
def analyze_audio(request: AnalyzeRequest):
    file_path = request.file_path
    temp_wav = None
    snd_path = file_path
    
    try:
        # If file is not a normalized WAV, preprocess it
        if not file_path.lower().endswith('_normalized.wav'):
            print(f"[Preprocess] Preprocessing and normalizing audio for Parselmouth: {file_path}")
            try:
                snd_path = preprocess_audio(file_path)
                # Mock a temp_wav object for cleanup in finally block
                class TempMock:
                    name = snd_path
                temp_wav = TempMock()
            except Exception as e:
                print(f"[Warning] Preprocessing failed in audio analysis: {e}. Using original file.")
                snd_path = file_path

        # Load audio using Praat Parselmouth
        snd = parselmouth.Sound(snd_path)
        
        # Auto-correlation fundamental frequency (F0 / Pitch) & Intensity
        pitch = snd.to_pitch()
        intensity = snd.to_intensity()
        duration = snd.duration
        
        pitch_data = []
        raw_emotions = []
        
        # Segment voice features per 1.0 second
        timestamps = np.arange(0.0, duration, 1.0)
        prev_intensity = 60.0
        
        for t in timestamps:
            # Sample F0 and intensity at 20 steps (every 50ms) within this 1s window
            window_times = np.arange(t, min(t + 1.0, duration), 0.05)
            
            p_vals = [pitch.get_value_at_time(wt) for wt in window_times]
            i_vals = [intensity.get_value(wt) for wt in window_times]
            
            valid_p = [float(p) for p in p_vals if not np.isnan(p) and p > 50.0]  # Min pitch 50Hz
            valid_i = [float(i) for i in i_vals if not np.isnan(i) and i > 0]
            
            mean_pitch = np.mean(valid_p) if valid_p else 0.0
            max_pitch = np.max(valid_p) if valid_p else 0.0
            min_pitch = np.min(valid_p) if valid_p else 0.0
            pitch_range = max_pitch - min_pitch
            
            mean_intensity = np.mean(valid_i) if valid_i else 50.0
            energy_delta = mean_intensity - prev_intensity
            prev_intensity = mean_intensity
            
            pitch_data.append({
                "timestamp_sec": round(float(t), 2),
                "pitch_hz": round(float(mean_pitch), 2),
                "intensity_db": round(float(mean_intensity), 2)
            })
            
            # Sophisticated audio emotion heuristic model
            # Categories: excited, calm, nervous, sad, confident, neutral
            emotion = "neutral"
            confidence = 0.7
            
            if mean_pitch > 0:
                # Excited: High pitch, high intensity, large pitch range
                if mean_pitch > 180 and mean_intensity > 68 and pitch_range > 40:
                    emotion = "excited"
                    confidence = 0.85
                # Nervous: High pitch, lower intensity, unstable pitch (large range)
                elif mean_pitch > 170 and mean_intensity < 65 and pitch_range > 50:
                    emotion = "nervous"
                    confidence = 0.75
                # Confident: Stable pitch (moderate range), high/medium-high intensity
                elif 110 <= mean_pitch <= 170 and mean_intensity > 66 and pitch_range <= 35:
                    emotion = "confident"
                    confidence = 0.8
                # Calm: Stable pitch, moderate intensity
                elif 100 <= mean_pitch <= 150 and 55 <= mean_intensity <= 66 and pitch_range <= 25:
                    emotion = "calm"
                    confidence = 0.8
                # Sad: Low pitch, low intensity
                elif mean_pitch < 110 and mean_intensity < 58:
                    emotion = "sad"
                    confidence = 0.75
            else:
                emotion = "neutral"
                confidence = 0.6
                
            raw_emotions.append({
                "timestamp_sec": round(float(t), 2),
                "emotion": emotion,
                "confidence": confidence
            })
            
        # Temporal smoothing of audio emotions (3-second window)
        audio_emotion = []
        for i in range(len(raw_emotions)):
            window = raw_emotions[max(0, i-1):min(len(raw_emotions), i+2)]
            
            # Count confidence-weighted emotions in window
            emotion_scores = {}
            for item in window:
                emo = item["emotion"]
                conf = item["confidence"]
                emotion_scores[emo] = emotion_scores.get(emo, 0.0) + conf
                
            best_emotion = max(emotion_scores, key=emotion_scores.get)
            
            # Average confidence of matching emotion in window
            matching_confs = [item["confidence"] for item in window if item["emotion"] == best_emotion]
            avg_conf = np.mean(matching_confs) if matching_confs else 0.7
            
            audio_emotion.append({
                "timestamp_sec": raw_emotions[i]["timestamp_sec"],
                "emotion": best_emotion,
                "confidence": round(float(avg_conf), 2)
            })
            
        # Voice quality metrics (Jitter, Shimmer, HNR) using Praat algorithms
        point_process = parselmouth.praat.call(snd, "To PointProcess (periodic, cc)", 75, 500)
        
        # Local Jitter & Shimmer
        local_jitter = parselmouth.praat.call(point_process, "Get jitter (local)...", 0, 0, 0.0001, 0.02, 1.3)
        local_shimmer = parselmouth.praat.call([snd, point_process], "Get shimmer (local)...", 0, 0, 0.0001, 0.02, 1.3, 1.6)
        
        # Harmonicity (Harmonic-to-Noise Ratio)
        harmonicity = snd.to_harmonicity()
        hnr = parselmouth.praat.call(harmonicity, "Get mean", 0, 0)
        
        # Check NaNs on silence
        jitter_val = float(local_jitter) if not np.isnan(local_jitter) else 0.015
        shimmer_val = float(local_shimmer) if not np.isnan(local_shimmer) else 0.045
        hnr_val = float(hnr) if not np.isnan(hnr) else 18.0
        
        voice_quality = {
            "jitter": round(jitter_val, 4),
            "shimmer": round(shimmer_val, 4),
            "hnr": round(hnr_val, 2)
        }
        
        return AudioAnalysisResponse(
            pitch_data=pitch_data,
            audio_emotion=audio_emotion,
            voice_quality=voice_quality
        )
    except Exception as e:
        print(f"Praat voice analysis failed: {e}")
        # Dynamic fallback on error/empty vokal
        return AudioAnalysisResponse(
            pitch_data=[{"timestamp_sec": 0.0, "pitch_hz": 120.0, "intensity_db": 60.0}],
            audio_emotion=[{"timestamp_sec": 0.0, "emotion": "neutral", "confidence": 0.8}],
            voice_quality={"jitter": 0.015, "shimmer": 0.045, "hnr": 18.0}
        )
    finally:
        if temp_wav and os.path.exists(temp_wav.name):
            try:
                os.remove(temp_wav.name)
            except Exception:
                pass

@app.post("/analyze/mbti", response_model=MbtiResponse)
def analyze_mbti(request: MbtiRequest):
    # 1. Parse metrics from request data
    exprs = request.expression_data
    voices = request.voice_data
    # PENTING: Semua transkrip = suara kandidat (tidak ada pewawancara)
    transcripts = request.transcript_data
    
    # 2. Calculate E vs I based on speaking rate and intensity
    words = 0
    start_time = 0.0
    end_time = 10.0
    if transcripts:
        start_time = transcripts[0].get('start_time', 0.0)
        end_time = transcripts[-1].get('end_time', 10.0)
        for t in transcripts:
            txt = t.get('text', '')
            if txt and not txt.startswith('['):
                words += len(txt.split())
                
    duration_min = max(0.1, (end_time - start_time) / 60.0)
    wpm = words / duration_min
    
    # Estimate mean intensity
    mean_intensity = 65.0
    if voices:
        intensities = [v.get('intensity_db', 65.0) for v in voices if v.get('intensity_db') is not None]
        if intensities:
            mean_intensity = sum(intensities) / len(intensities)
            
    # E/I Score Logic
    e_score = 0.5 + (wpm - 120.0) / 150.0 + (mean_intensity - 66.0) / 40.0
    e_score = max(0.15, min(0.85, round(e_score, 2)))
    i_score = round(1.0 - e_score, 2)
    
    # 3. Calculate S vs N based on transcript keywords
    abstract_words = ["konsep", "ide", "analisis", "teori", "strategi", "perencanaan", "abstrak", "visi", "pikir", "inovasi", "kreatif"]
    concrete_words = ["praktis", "nyata", "fakta", "contoh", "aplikasi", "kode", "program", "desain", "buat", "kerja", "tugas"]
    
    abstract_count = 0
    concrete_count = 0
    if transcripts:
        all_text = " ".join([t.get('text', '').lower() for t in transcripts])
        for aw in abstract_words:
            abstract_count += all_text.count(aw)
        for cw in concrete_words:
            concrete_count += all_text.count(cw)
            
    # Default slight Sensing bias for typical interviews, adjusted by abstract ratio
    s_base = 0.55
    if (abstract_count + concrete_count) > 0:
        n_ratio = abstract_count / (abstract_count + concrete_count)
        s_score = s_base - (n_ratio - 0.5) * 0.4
    else:
        s_score = s_base
        
    s_score = max(0.15, min(0.85, round(s_score, 2)))
    n_score = round(1.0 - s_score, 2)
    
    # 4. Calculate T vs F based on smiling ratio in expressions
    smile_ratio = 0.2
    if exprs:
        happy_frames = sum(1 for e in exprs if e.get('emotion') == 'happy')
        smile_ratio = happy_frames / len(exprs)
        
    f_score = 0.35 + (smile_ratio * 1.5)
    f_score = max(0.15, min(0.85, round(f_score, 2)))
    t_score = round(1.0 - f_score, 2)
    
    # 5. Calculate J vs P based on filler words ratio
    filler_ratio = 0.1
    total_fillers = 0
    if transcripts:
        total_fillers = sum(t.get('filler_count', 0) for t in transcripts)
        total_words_approx = sum(len(t.get('text', '').split()) for t in transcripts)
        if total_words_approx > 0:
            filler_ratio = total_fillers / total_words_approx
        else:
            filler_ratio = total_fillers / max(1, len(transcripts))
        
    p_score = 0.25 + (filler_ratio * 4.0)  # Calibrated scaling since ratio is per word now
    p_score = max(0.15, min(0.85, round(p_score, 2)))
    j_score = round(1.0 - p_score, 2)
    
    # Compile MBTI predicted type
    predicted = (
        ("E" if e_score > i_score else "I") +
        ("S" if s_score > n_score else "N") +
        ("T" if t_score > f_score else "F") +
        ("J" if j_score > p_score else "P")
    )
    
    scores = {
        "E": e_score,
        "I": i_score,
        "S": s_score,
        "N": n_score,
        "T": t_score,
        "F": f_score,
        "J": j_score,
        "P": p_score
    }
    
    # Formulate contextual, logical reasoning
    reasoning = {
        "E_I": f"Kandidat cenderung menunjukkan gaya komunikasi yang {'Ekspresif & Terbuka' if e_score > i_score else 'Reflektif & Tenang'} dengan tempo bicara {int(wpm)} WPM dan intensitas vokal rata-rata {mean_intensity:.1f} dB.",
        "S_N": f"Kandidat berfokus pada penyampaian informasi secara {'Praktis & Faktual' if s_score > n_score else 'Konseptual & Strategis'} berdasarkan pilihan diksi yang digunakan selama sesi.",
        "T_F": f"Kandidat memiliki gaya keputusan yang cenderung {'Logis & Objektif' if t_score > f_score else 'Empatis & Personal'} dengan rasio senyuman wajah sekitar {int(smile_ratio*100)}%.",
        "J_P": f"Kandidat menampilkan gaya kerja yang {'Terstruktur & Terencana' if j_score > p_score else 'Adaptif & Spontan'} terlihat dari pola kelancaran bicara dan penggunaan filler words."
    }
    
    default_recs = [
        "Latih kejelasan vokal Anda dan pertahankan kontak mata yang stabil untuk memancarkan rasa percaya diri.",
        "Cobalah untuk mengurangi filler words dengan beristirahat sejenak (pausing) sebelum menjawab pertanyaan.",
        "Tonjolkan kekuatan alami karakter komunikasi Anda untuk menyajikan solusi masalah secara terstruktur."
    ]
    
    default_summary = (
        f"Kandidat menunjukkan profil komunikasi yang berciri khas {'Ekspresif & Terbuka' if e_score > i_score else 'Reflektif & Tenang'} dengan tingkat kelancaran WPM sebesar {int(wpm)} "
        f"dan rasio senyuman {int(smile_ratio*100)}%. Pola ekspresi dan intonasi vokal kandidat cenderung stabil secara umum. "
        f"Kandidat direkomendasikan untuk meningkatkan antusiasme dan meminimalkan filler words guna memperkuat dampak penyampaian."
    )
    
    confidence = round(0.7 + (abs(e_score - i_score) + abs(s_score - n_score) + abs(t_score - f_score) + abs(j_score - p_score)) / 4.0, 2)
    confidence = max(0.70, min(0.98, confidence))

    # Ambil SELURUH teks kandidat (semua transkrip = monolog kandidat)
    full_transcript = " ".join([t.get('text', '') for t in transcripts if t.get('text')]).strip()
    if not full_transcript:
        full_transcript = "(Tidak ada pembicaraan terdeteksi)"

    # Hitung total kata dan filler untuk dimasukkan ke prompt
    total_words = sum(len(t.get('text', '').split()) for t in transcripts)

    prompt = f"""
    Anda adalah seorang Psikolog Industri dan Organisasi profesional ahli rekrutmen.
    
    Anda sedang menganalisis rekaman video wawancara kerja di mana HANYA ADA SATU PEMBICARA, yaitu kandidat/pelamar kerja.
    Tidak ada pewawancara dalam rekaman — kandidat berbicara sendiri (misalnya: video pitch diri, monolog self-introduction, atau jawaban atas pertanyaan yang sudah disiapkan sebelumnya).
    
    Berdasarkan data multimodal berikut, buatlah analisis mendalam tentang gaya karakter dan komunikasi kandidat.
    JANGAN menyebutkan label singkatan MBTI (seperti ENFP, ISTJ, dll) secara langsung di dalam teks analisis.
    Analisis harus ditulis dalam Bahasa Indonesia yang formal dan profesional.
    
    ═══════════════════════════════════════════
    DATA MULTIMODAL KANDIDAT
    ═══════════════════════════════════════════
    - Estimasi Tipe Dasar: {predicted}
    - Skor Dimensi Kepribadian: {scores}
    - Kecepatan Bicara: {int(wpm)} WPM (kata per menit)
    - Total Kata Diucapkan: {total_words} kata
    - Filler Words Terdeteksi: {total_fillers} segmen dari {len(transcripts)} segmen total
    - Rasio Filler Words: {filler_ratio:.2f}
    - Intensitas Suara Rata-rata: {mean_intensity:.1f} dB
    - Rasio Senyuman Wajah (Happy Expressions): {smile_ratio:.2f} ({int(smile_ratio*100)}%)
    
    ═══════════════════════════════════════════
    TRANSKRIP LENGKAP KANDIDAT (monolog)
    ═══════════════════════════════════════════
    "{full_transcript}"
    
    ═══════════════════════════════════════════
    TUGAS ANALISIS
    ═══════════════════════════════════════════
    1. Buat analisis mendalam (masing-masing 1-2 kalimat profesional) untuk SETIAP dimensi berikut di dalam objek JSON `reasoning`:
       - E_I (Ekspresi Interpersonal): Jelaskan gaya komunikasi verbal/non-verbal kandidat (Komunikatif & Ekspresif vs Reflektif & Tenang) — kaitkan dengan data WPM, intensitas suara, DAN isi/gaya bicara dari transkrip.
       - S_N (Fokus Informasi): Jelaskan bagaimana kandidat menangkap dan menyajikan informasi (Praktis & Berorientasi Fakta vs Konseptual & Strategis) — berdasarkan kata-kata dan topik konkret/abstrak yang diucapkan.
       - T_F (Gaya Keputusan): Jelaskan cara kandidat mengambil keputusan dan menyampaikan pendapat (Logis & Objektif vs Empatis & Personal) — kaitkan dengan isi bicara, ekspresi wajah, dan pilihan kata.
       - J_P (Gaya Kerja): Jelaskan bagaimana kandidat mengatur dan menyampaikan pikiran (Terstruktur & Rapi vs Adaptif & Spontan) — berdasarkan stabilitas tempo bicara dan frekuensi filler words.
    
    2. Berikan 3 rekomendasi perbaikan komunikasi yang sangat operasional, taktis, dan personal bagi kandidat (sebagai array `recommendations`).
       Rekomendasi harus SPESIFIK dan langsung dapat dipraktikkan berdasarkan kelemahan nyata yang terdeteksi dari data di atas.
    
    3. Tulis `executive_summary` berupa ringkasan profesional mendalam (Bahasa Indonesia) yang WAJIB mencakup:
       a. Topik utama dan hal-hal yang disampaikan oleh kandidat dalam monolognya (berdasarkan transkrip).
       b. Gaya dan cara berbicara kandidat: kecepatan tempo WPM, intensitas vokal, ekspresi wajah, kelancaran bicara.
       c. Karakter kepribadian kandidat secara keseluruhan beserta kekuatan dan kelemahan soft skill yang teridentifikasi.
       d. Tingkat kesiapan kandidat untuk posisi yang dilamar.
    
    Jawablah dalam format JSON terstruktur yang valid sesuai schema MbtiResponse.
    """

    groq_api_key = os.environ.get("GROQ_API_KEY")
    groq_model = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
    
    use_groq = bool(groq_api_key)
    
    if not use_groq:
        print("[Warning] GROQ_API_KEY is not configured. Falling back to heuristic analysis.")
        return MbtiResponse(
            predicted_type=predicted,
            scores=scores,
            confidence=confidence,
            reasoning=reasoning,
            recommendations=default_recs,
            executive_summary=default_summary
        )
    
    try:
        print(f"[MBTI] Generating character reasoning & recommendations using Groq ({groq_model})...")
        from groq import Groq
        import json
        
        client = Groq(api_key=groq_api_key)
        
        messages = [
            {
                "role": "system", 
                "content": "Anda adalah seorang Psikolog Industri dan Organisasi profesional ahli rekrutmen. Rekaman yang dianalisis hanya berisi suara kandidat (monolog/self-pitch), tidak ada pewawancara. Berikan respons dalam format JSON yang valid sesuai dengan skema output MbtiResponse."
            },
            {
                "role": "user",
                "content": prompt
            }
        ]
        
        completion = client.chat.completions.create(
            model=groq_model,
            messages=messages,
            temperature=0.2,
            response_format={"type": "json_object"}
        )
        
        content_str = completion.choices[0].message.content
        data = json.loads(content_str)
        
        return MbtiResponse(
            predicted_type=predicted,
            scores=scores,
            confidence=confidence,
            reasoning=data.get("reasoning", reasoning),
            recommendations=data.get("recommendations", default_recs),
            executive_summary=data.get("executive_summary", default_summary)
        )
    except Exception as e:
        print(f"[Error] Groq character analysis failed: {e}. Falling back to heuristic.")
        return MbtiResponse(
            predicted_type=predicted,
            scores=scores,
            confidence=confidence,
            reasoning=reasoning,
            recommendations=default_recs,
            executive_summary=default_summary
        )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
