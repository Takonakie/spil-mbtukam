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
from google import genai
from google.genai import types
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

class DialogueSegment(BaseModel):
    index: int
    text: str

class DialogueRequest(BaseModel):
    segments: List[DialogueSegment]

class ClassifiedSegment(BaseModel):
    index: int
    speaker: str
    speech_act: str

class DialogueResponse(BaseModel):
    segments: List[ClassifiedSegment]

# Initialize Whisper model globally on CPU or GPU
print("Loading Whisper model...")
device = "cuda" if torch.cuda.is_available() else "cpu"
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
        
    return results

@app.post("/analyze/transcript", response_model=List[TranscriptSegment])
def analyze_transcript(request: AnalyzeRequest):
    file_path = request.file_path
    
    # Contextual disfluency lexicons
    indonesian_fillers = ["anu", "ehm", "ehh", "umm", "hmm", "gitu", "kayak", "jadi", "ya kan", "tuh", "nah", "kan", "sih", "kok", "deh"]
    english_fillers = ["um", "uh", "like", "you know", "basically", "actually", "literally", "so", "right", "well"]
    all_fillers = indonesian_fillers + english_fillers
    
    # Biasing decoder toward disfluencies
    prompt = "Umm, ehh, anu, kayak, jadi gitu, hmm, ya kan, gitu lho, actually, basically, you know"
    
    try:
        # Transcribe with natural sentence/clause segmentation Timing
        result = whisper_model.transcribe(
            file_path, 
            initial_prompt=prompt
        )
        
        segments = []
        for seg in result.get("segments", []):
            text = seg.get("text", "").strip()
            if not text:
                continue
                
            # Scan the words in this sentence segment for any filler words
            words_list = text.split()
            is_filler = False
            first_filler = None
            
            for w in words_list:
                w_clean = w.lower().strip(",.!?\"'")
                if w_clean in all_fillers:
                    is_filler = True
                    first_filler = w_clean
                    break
                    
            segments.append(TranscriptSegment(
                start_time=float(seg.get("start", 0.0)),
                end_time=float(seg.get("end", 0.0)),
                text=text,
                is_filler=is_filler,
                filler_type=first_filler
            ))
            
        if not segments:
            segments.append(TranscriptSegment(
                start_time=0.0,
                end_time=1.0,
                text="[Hening]",
                is_filler=False
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
        import tempfile
        import subprocess
        
        # If file is not WAV, convert it to temporary WAV using ffmpeg
        if not file_path.lower().endswith('.wav'):
            temp_wav = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
            temp_wav.close() # Close it so subprocess can write to it
            
            # Run ffmpeg command to extract audio
            cmd = [
                'ffmpeg', '-y', '-i', file_path, 
                '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', 
                temp_wav.name
            ]
            # Hide console window on Windows
            startupinfo = None
            if os.name == 'nt':
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                
            print(f"🎬 Converting {file_path} to WAV temp file for Parselmouth...")
            subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, startupinfo=startupinfo, check=True)
            snd_path = temp_wav.name

        # Load audio using Praat Parselmouth
        snd = parselmouth.Sound(snd_path)
        
        # Auto-correlation fundamental frequency (F0 / Pitch) & Intensity
        pitch = snd.to_pitch()
        intensity = snd.to_intensity()
        duration = snd.duration
        
        pitch_data = []
        audio_emotion = []
        
        # Segment voice features per 1.0 second
        timestamps = np.arange(0.0, duration, 1.0)
        for t in timestamps:
            p_val = pitch.get_value_at_time(t)
            i_val = intensity.get_value(t)
            
            pitch_hz = float(p_val) if not np.isnan(p_val) and p_val > 0 else 0.0
            intensity_db = float(i_val) if not np.isnan(i_val) and i_val > 0 else 50.0  # Min noise floor
            
            pitch_data.append({
                "timestamp_sec": round(float(t), 2),
                "pitch_hz": round(pitch_hz, 2),
                "intensity_db": round(intensity_db, 2)
            })
            
            # Simple pitch-energy based heuristic audio emotion model
            if pitch_hz > 175 and intensity_db > 68:
                emotion = "happy"
            elif pitch_hz < 105 and pitch_hz > 0:
                emotion = "sad"
            else:
                emotion = "neutral"
                
            audio_emotion.append({
                "timestamp_sec": round(float(t), 2),
                "emotion": emotion,
                "confidence": 0.8
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
        # Dynamic fallback on error/empty voice
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
    transcripts = request.transcript_data
    
    # 2. Calculate E vs I based on speaking rate and intensity
    # Estimate speaking rate
    words = 0
    start_time = 0.0
    end_time = 10.0
    if transcripts:
        start_time = transcripts[0].get('start_time', 0.0)
        end_time = transcripts[-1].get('end_time', 10.0)
        for t in transcripts:
            if not t.get('is_filler', False):
                words += len(t.get('text', '').split())
                
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
    if transcripts:
        fillers = sum(1 for t in transcripts if t.get('is_filler', False))
        filler_ratio = fillers / len(transcripts)
        
    p_score = 0.25 + (filler_ratio * 2.0)
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
        "E_I": f"Kandidat tergolong {'Extraversion' if e_score > i_score else 'Introversion'} karena memiliki tempo bicara {int(wpm)} WPM dengan intensitas vokal rata-rata {mean_intensity:.1f} dB yang {'mantap dan asertif' if mean_intensity > 66 else 'tenang dan reflektif'}.",
        "J_P": f"Kandidat didominasi {'Judging' if j_score > p_score else 'Perceiving'} berkat rasio kata filler yang {'sangat rendah' if filler_ratio < 0.1 else 'cukup dinamis'}, mencerminkan pola penyampaian yang {'terstruktur teratur' if j_score > p_score else 'adaptif dan spontan'}.",
        "S_N": f"Kandidat cenderung {'Sensing' if s_score > n_score else 'Intuition'} (skor {int(s_score*100)}% vs {int(n_score*100)}%) berdasarkan penggunaan diksi dan fokus pembicaraan yang lebih {'praktis/realistis' if s_score > n_score else 'konseptual/strategis'}.",
        "T_F": f"Kandidat dinilai lebih {'Thinking' if t_score > f_score else 'Feeling'} dengan rasio senyuman {int(smile_ratio*100)}% selama interview, menunjukkan kecenderungan {'keputusan logis objektif' if t_score > f_score else 'pendekatan empatik interpersonal'}."
    }
    
    default_recs = [
        "Latih kejelasan vokal Anda dan pertahankan kontak mata yang stabil untuk memancarkan rasa percaya diri.",
        "Cobalah untuk mengurangi filler words dengan beristirahat sejenak (pausing) sebelum menjawab pertanyaan.",
        f"Sebagai seorang {predicted}, manfaatkan kekuatan kepribadian Anda untuk menyajikan solusi masalah secara logis dan terstruktur."
    ]
    
    default_summary = (
        f"Kandidat menunjukkan profil komunikasi yang berciri khas {predicted} dengan tingkat kelancaran WPM sebesar {int(wpm)} "
        f"dan rasio senyuman {int(smile_ratio*100)}%. Pola ekspresi dan intonasi vokal kandidat cenderung stabil secara umum. "
        f"Kandidat direkomendasikan untuk meningkatkan antusiasme dan meminimalkan filler words guna memperkuat dampak penyampaian."
    )
    
    confidence = round(0.7 + (abs(e_score - i_score) + abs(s_score - n_score) + abs(t_score - f_score) + abs(j_score - p_score)) / 4.0, 2)
    confidence = max(0.70, min(0.98, confidence))

    api_key = os.environ.get("GEMINI_API_KEY")
    gemini_model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
    
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="GEMINI_API_KEY is not configured in the environment. It is required to generate the executive summary."
        )
    
    try:
        print(f"🧠 Generating Gemini clinical MBTI reasoning & recommendations using {gemini_model}...")
        client = genai.Client(api_key=api_key)
        
        prompt = f"""
        Anda adalah seorang Psikolog Industri dan Organisasi profesional ahli rekrutmen. Berdasarkan data multimodal kandidat berikut:
        - Estimasi MBTI: {predicted}
        - Skor Kepribadian: {scores}
        - Kecepatan Vokal WPM: {int(wpm)} WPM
        - Rasio Filler Words: {filler_ratio:.2f}
        - Intensitas Suara Rata-rata: {mean_intensity:.1f} dB
        - Rasio Senyuman Wajah: {smile_ratio:.2f}
        
        Tugas Anda adalah:
        1. Buat kalimat analisis yang sangat mendalam (masing-masing 1 kalimat profesional) untuk dimensi:
           - E_I: Extraversion vs Introversion
           - S_N: Sensing vs Intuition
           - T_F: Thinking vs Feeling
           - J_P: Judging vs Perceiving
        2. Berikan 3 poin rekomendasi perbaikan komunikasi/karier yang sangat operasional dan personal bagi kandidat (sebagai List of strings).
        3. Tulis executive_summary berupa 3 kalimat profesional bahasa Indonesia yang mendalam mengenai rangkuman komunikasi, emosi, dan kecocokan soft skill kandidat.
        
        Jawablah dalam format JSON terstruktur yang valid sesuai schema MbtiResponse.
        """
        
        response = client.models.generate_content(
            model=gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=MbtiResponse,
                temperature=0.2
            ),
        )
        
        import json
        data = json.loads(response.text)
        return MbtiResponse(
            predicted_type=predicted,
            scores=scores,
            confidence=confidence,
            reasoning=data.get("reasoning", reasoning),
            recommendations=data.get("recommendations", default_recs),
            executive_summary=data.get("executive_summary", default_summary)
        )
    except Exception as e:
        print(f"❌ Gemini MBTI reasoning generation failed: {e}.")
        raise HTTPException(
            status_code=500,
            detail=f"Gemini MBTI reasoning generation failed: {str(e)}"
        )

@app.post("/analyze/dialogue", response_model=DialogueResponse)
def analyze_dialogue(request: DialogueRequest):
    api_key = os.environ.get("GEMINI_API_KEY")
    
    if not api_key:
        print("⚠️ GEMINI_API_KEY not found in environment. Falling back to advanced stateful heuristic dialogue classifier.")
        classified = []
        current_speaker = "interviewer"
        
        interviewer_pronouns = ["kamu", "anda", "lu", "dikau"]
        candidate_pronouns = ["saya", "aku", "gue", "kami", "daku"]
        
        interviewer_actions = ["ceritakan", "jelaskan", "sebutkan", "bagaimana", "mengapa", "kenapa", "apakah", "bisa", "tolong", "silakan", "cv", "resume", "portofolio", "posisi", "lowongan", "perusahaan", "magang", "intern", "employee", "pekerjaan", "pengalaman", "gaji", "apply", "melamar"]
        candidate_responses = ["jadi", "pertama", "sebelumnya", "pengalaman", "proyek", "bahasa", "framework", "kuliah", "jurusan", "belajar", "tertarik", "minat", "keahlian", "kemampuan", "menggunakan", "membuat", "membangun", "mengembangkan"]
        
        for idx, seg in enumerate(request.segments):
            text_lower = seg.text.lower()
            words = text_lower.split()
            word_count = len(words)
            
            is_question = "?" in seg.text or any(text_lower.startswith(q) for q in ["siapa", "apa", "kapan", "dimana", "mengapa", "bagaimana", "apakah", "kenapa", "gimana", "kok", "apakah"])
            
            has_interviewer_pronouns = any(p in words for p in interviewer_pronouns)
            has_candidate_pronouns = any(p in words for p in candidate_pronouns)
            has_interviewer_actions = any(a in text_lower for a in interviewer_actions)
            has_candidate_responses = any(r in text_lower for r in candidate_responses)
            
            is_interviewer = False
            
            if idx == 0:
                is_interviewer = True
            elif is_question:
                if has_candidate_pronouns and "tanya" in text_lower:
                    is_interviewer = False
                elif has_interviewer_pronouns or has_interviewer_actions:
                    is_interviewer = True
                elif word_count < 15:
                    is_interviewer = True
                else:
                    is_interviewer = True
            else:
                if has_candidate_pronouns and word_count > 10:
                    is_interviewer = False
                elif has_interviewer_actions and not has_candidate_pronouns and word_count < 12:
                    is_interviewer = True
                elif word_count > 25:
                    is_interviewer = False
                else:
                    is_interviewer = (current_speaker == "interviewer")
            
            current_speaker = "interviewer" if is_interviewer else "candidate"
            speech_act = "question" if is_question else ("answer" if current_speaker == "candidate" else "statement")
            
            classified.append(ClassifiedSegment(
                index=seg.index,
                speaker=current_speaker,
                speech_act=speech_act
            ))
        return DialogueResponse(segments=classified)
        
    try:
        client = genai.Client(api_key=api_key)
        
        segments_str = "\n".join([f"[{seg.index}] {seg.text}" for seg in request.segments])
        
        prompt = f"""
        Anda adalah seorang ahli linguistik forensik dan psikolog rekrutmen profesional. Tugas Anda adalah menganalisis transkrip percakapan wawancara kerja terbagi berdasarkan segmen-segmen berikut, lalu membedakan pembicaranya antara Pewawancara (interviewer) dan Pelamar/Kandidat (candidate).
        
        Bahasa yang digunakan dalam wawancara ini sering kali tidak baku (informal/colloquial Indonesian), menggunakan slang, singkatan, partikel percakapan (seperti "sih", "kok", "lho", "kan", "deh"), kata ganti tidak baku ("gue", "lu", "aku", "kamu", "ente"), atau kata hubung tidak baku ("kalo", "yg", "aja", "nanya", "emang", "sebenernya").
        
        Data segmen transkrip berurutan:
        {segments_str}
        
        Aturan Penting Pemahaman Konteks:
        1. Bacalah SELURUH segmen dari awal sampai akhir secara berurutan untuk memahami ALUR percakapan secara utuh. Jangan menganalisis segmen secara terpisah!
        2. Pewawancara (interviewer):
           - Biasanya memulai sesi (perkenalan, menyapa, memberikan instruksi).
           - Mengajukan pertanyaan tentang latar belakang, kelebihan, kekurangan, gaji, motivasi, proyek masa lalu.
           - Memberikan tanggapan singkat ("oke", "baik", "menarik sekali") sebelum mengajukan pertanyaan berikutnya.
        3. Pelamar/Kandidat (candidate):
           - Menjawab pertanyaan dari pewawancara secara panjang lebar dan menjelaskan detail teknis atau pengalaman kerjanya.
           - Terkadang kandidat bertanya balik di akhir sesi (misalnya menanyakan budaya kerja, kelanjutan proses, dsb.).
        4. Tentukan pembicara (speaker): "interviewer" or "candidate".
        5. Tentukan jenis tuturan (speech_act):
           - "question": Jika segmen tersebut berupa pertanyaan atau mengandung kalimat tanya (baik dari pewawancara maupun kandidat).
           - "answer": Jika segmen tersebut merupakan bagian dari jawaban atau penjelasan kandidat terhadap pertanyaan pewawancara.
           - "statement": Jika berupa pernyataan umum, salam pembuka/penutup, feedback singkat, atau penjelasan yang bukan merupakan tanya-jawab langsung.
        
        Berikan jawaban dalam format JSON terstruktur yang valid sesuai dengan skema output.
        """
        
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=DialogueResponse,
                temperature=0.15
            ),
        )
        
        import json
        data = json.loads(response.text)
        
        classified = []
        for seg in data.get("segments", []):
            classified.append(ClassifiedSegment(
                index=int(seg.get("index")),
                speaker=seg.get("speaker"),
                speech_act=seg.get("speech_act")
            ))
        return DialogueResponse(segments=classified)
    except Exception as e:
        print(f"❌ Gemini dialogue classification failed: {e}. Falling back to stateful heuristics.")
        # Fallback to advanced stateful heuristic
        classified = []
        current_speaker = "interviewer"
        
        for idx, seg in enumerate(request.segments):
            text_lower = seg.text.lower()
            is_question = "?" in seg.text
            
            is_interviewer = False
            if idx == 0:
                is_interviewer = True
            elif is_question:
                is_interviewer = True
            else:
                if len(text_lower.split()) > 20:
                    is_interviewer = False
                else:
                    is_interviewer = (current_speaker == "interviewer")
            
            current_speaker = "interviewer" if is_interviewer else "candidate"
            speech_act = "question" if is_question else ("answer" if current_speaker == "candidate" else "statement")
            
            classified.append(ClassifiedSegment(
                index=seg.index,
                speaker=current_speaker,
                speech_act=speech_act
            ))
        return DialogueResponse(segments=classified)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
