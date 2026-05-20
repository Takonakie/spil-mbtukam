# 🎯 Interview Analyzer — Planning Document

> Aplikasi analisis interview untuk mendeteksi ekspresi wajah, kualitas suara, filler words, dan estimasi MBTI.
> Data: Video interview anak magang & karyawan.

---

## Tech Stack

| Layer | Teknologi |
|---|---|
| Runtime | **Bun** |
| Backend | **ElysiaJS** |
| ORM | **Drizzle** + **PostgreSQL** |
| Frontend | **Vite + React** (on Bun) |
| Face Mesh | **MediaPipe Face Mesh** (browser) |
| Expression AI | **DeepFace** (Python service) |
| Audio Features | **YAMNet / Wav2Vec 2.0** (Python service) |
| Pitch Analysis | **Praat** via `parselmouth` (Python service) |
| Transcription | **OpenAI Whisper** (Python service) |
| MBTI Engine | **Rule-based + ML classifier** (Python service) |

---

## Arsitektur Sistem

```
┌─────────────────────────────────────────────────────┐
│                   FRONTEND (Bun + Vite)             │
│  Dashboard UI / Upload / MediaPipe Face Mesh Preview│
└──────────────────────┬──────────────────────────────┘
                       │ REST API
┌──────────────────────▼──────────────────────────────┐
│              BACKEND (ElysiaJS on Bun)              │
│  API Routes → Job Dispatcher → Result Aggregator    │
│  Drizzle ORM ←→ PostgreSQL                          │
└──────────────────────┬──────────────────────────────┘
                       │ Internal HTTP
┌──────────────────────▼──────────────────────────────┐
│           PYTHON AI MICROSERVICES (FastAPI)          │
│                                                     │
│  ┌───────────┐ ┌───────────┐ ┌───────────────────┐  │
│  │ DeepFace  │ │  Whisper  │ │ YAMNet/Wav2Vec +  │  │
│  │(Ekspresi) │ │(Transkrip)│ │ Praat (Audio)     │  │
│  └───────────┘ └───────────┘ └───────────────────┘  │
│                                                     │
│  ┌─────────────────────────────────────────────────┐ │
│  │         MBTI Estimation Engine                  │ │
│  │  Mengkonsumsi output dari semua service di atas │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

**Kenapa Dual Runtime?**
- MediaPipe, DeepFace, Praat, Whisper, YAMNet → ekosistem **Python**
- Web server, API, DB, frontend → **Bun + ElysiaJS + Drizzle** (cepat & type-safe)
- Komunikasi: REST API internal antar service

---

## Folder Structure

```
expression/
├── backend/                    # ElysiaJS + Drizzle
│   ├── src/
│   │   ├── modules/
│   │   │   ├── interviews/     # CRUD + upload
│   │   │   ├── analysis/       # Trigger & result endpoints
│   │   │   └── mbti/           # MBTI result endpoints
│   │   ├── db/
│   │   │   ├── schema/         # Drizzle table definitions
│   │   │   └── migrations/
│   │   ├── shared/             # Utils, error handling
│   │   └── index.ts
│   ├── drizzle.config.ts
│   └── package.json
├── frontend/                   # Vite + React
│   ├── src/
│   │   ├── pages/
│   │   ├── components/
│   │   └── hooks/
│   └── package.json
├── ai-services/                # Python FastAPI
│   ├── services/
│   │   ├── deepface_service.py
│   │   ├── whisper_service.py
│   │   ├── audio_service.py    # YAMNet/Wav2Vec + Praat
│   │   ├── mbti_service.py     # MBTI estimation engine
│   │   └── main.py             # FastAPI entry
│   └── requirements.txt
├── docker-compose.yml
├── PLANNING.md
└── README.md
```

---

## Database Schema (Drizzle)

### Tabel: `interviews`
| Column | Type | Keterangan |
|---|---|---|
| id | uuid, PK | |
| candidate_name | varchar | |
| candidate_type | enum | 'intern' \| 'employee' |
| video_url | varchar | Path ke file video |
| audio_url | varchar | Path ke extracted audio |
| duration_seconds | integer | |
| status | enum | 'uploaded' \| 'processing' \| 'completed' \| 'failed' |
| created_at | timestamp | |

### Tabel: `expression_results`
| Column | Type | Keterangan |
|---|---|---|
| id | uuid, PK | |
| interview_id | uuid, FK | |
| timestamp_sec | float | Detik ke-n dalam video |
| emotion | varchar | 'happy', 'sad', 'angry', 'surprise', 'neutral', 'fear', 'disgust' |
| confidence | float | 0.0 ~ 1.0 |

### Tabel: `voice_results`
| Column | Type | Keterangan |
|---|---|---|
| id | uuid, PK | |
| interview_id | uuid, FK | |
| timestamp_sec | float | |
| pitch_hz | float | Fundamental frequency |
| intensity_db | float | Loudness |
| jitter | float | Pitch stability |
| shimmer | float | Amplitude stability |
| hnr | float | Harmonic-to-noise ratio |
| audio_emotion | varchar | Emosi dari suara |

### Tabel: `transcript_segments`
| Column | Type | Keterangan |
|---|---|---|
| id | uuid, PK | |
| interview_id | uuid, FK | |
| start_time | float | |
| end_time | float | |
| text | text | Transkrip segment |
| is_filler | boolean | Apakah filler word |
| filler_type | varchar | Nullable — 'umm', 'ehh', dll. |

### Tabel: `mbti_results`
| Column | Type | Keterangan |
|---|---|---|
| id | uuid, PK | |
| interview_id | uuid, FK | |
| predicted_type | varchar(4) | Contoh: 'ENFP', 'ISTJ' |
| e_score / i_score | float | Skor Extraversion vs Introversion |
| s_score / n_score | float | Skor Sensing vs Intuition |
| t_score / f_score | float | Skor Thinking vs Feeling |
| j_score / p_score | float | Skor Judging vs Perceiving |
| confidence | float | 0.0 ~ 1.0 |
| reasoning | jsonb | Penjelasan per dimensi |

### Tabel: `analysis_summary`
| Column | Type | Keterangan |
|---|---|---|
| id | uuid, PK | |
| interview_id | uuid, FK | |
| dominant_emotion | varchar | |
| emotion_stability_score | float | 0~100 |
| avg_pitch_hz | float | |
| pitch_variation | float | |
| speaking_rate_wpm | float | Words per minute |
| filler_count | integer | |
| filler_percentage | float | |
| mbti_type | varchar(4) | Hasil estimasi MBTI |
| overall_score | float | 0~100 |
| recommendations | jsonb | Saran perbaikan |

---

## Phase 1 — Project Setup & Scaffolding

**Tujuan**: Semua service bisa start tanpa error.

**Tugas**:
1. Init monorepo sesuai folder structure di atas
2. Backend: `bun init` → install `elysia`, `drizzle-orm`, `drizzle-kit`, `postgres`
3. Frontend: `bun create vite frontend --template react-ts` → install `@mediapipe/tasks-vision`
4. Python: Virtual env + install `fastapi`, `uvicorn`, `deepface`, `openai-whisper`, `parselmouth`, `tensorflow`, `transformers`
5. Docker Compose: PostgreSQL container + (opsional) Redis
6. Buat health check endpoint di backend & ai-services

**Definisi Selesai**: `bun run dev` di backend, `bun run dev` di frontend, `uvicorn main:app` di ai-services — semua respond tanpa error.

---

## Phase 2 — Database Schema & Migration

**Tujuan**: Database siap dengan semua tabel.

**Tugas**:
1. Buat Drizzle schema files di `backend/src/db/schema/`
2. Generate migration: `bunx drizzle-kit generate`
3. Jalankan migration: `bunx drizzle-kit migrate`
4. Buat seed script dengan data dummy

**Definisi Selesai**: Semua tabel exist di PostgreSQL, bisa insert & query data dummy.

---

## Phase 3 — Upload & Processing Pipeline

**Tujuan**: User upload video → sistem extract audio → dispatch ke AI services.

**Alur**:
```
Upload Video → Simpan File → Insert DB (status: uploaded)
    → Extract Audio via FFmpeg (.wav 16kHz mono)
    → Update status: processing
    → Dispatch 4 parallel jobs ke Python AI Services
    → Semua selesai → Hitung summary + MBTI → status: completed
```

**Tugas**:
1. Endpoint `POST /api/interviews/upload` — terima multipart file
2. FFmpeg: `ffmpeg -i video.mp4 -ar 16000 -ac 1 audio.wav`
3. Job dispatcher: panggil Python services secara parallel via HTTP
4. Status tracking & error handling per service

**Definisi Selesai**: Upload video → audio ter-extract → semua AI service terpanggil → hasil tersimpan di DB.

---

## Phase 4 — Python AI Microservices

### 4A. DeepFace — Facial Expression
- **Endpoint**: `POST /analyze/expression`
- **Input**: Path ke video
- **Output**: `[{ timestamp, emotion, confidence }]`
- **Cara**: Extract frame per 0.5 detik → `DeepFace.analyze(frame, actions=['emotion'])`
- Handle "no face detected" → skip, jangan crash

### 4B. Whisper — Transcription & Filler Detection
- **Endpoint**: `POST /analyze/transcript`
- **Input**: Path ke audio (.wav)
- **Output**: `[{ start, end, text, is_filler, filler_type }]`
- **Cara**: Load model Whisper → transcribe dengan `word_timestamps=True`
- Gunakan `initial_prompt` berisi filler words untuk meningkatkan deteksi
- Post-process: cocokkan setiap kata dengan daftar filler words

**Daftar Filler Words**:
```
ID: "anu", "ehm", "ehh", "umm", "hmm", "gitu", "kayak", "jadi", "ya kan", "tuh", "nah"
EN: "um", "uh", "like", "you know", "basically", "actually", "so", "right", "well"
```

### 4C. Audio Analysis — YAMNet/Wav2Vec + Praat
- **Endpoint**: `POST /analyze/audio`
- **Input**: Path ke audio (.wav)
- **Output**: `{ pitch_data, audio_emotion, voice_quality }`
- **Praat** (via parselmouth): Pitch contour (F0), jitter, shimmer, HNR, intensity
- **YAMNet/Wav2Vec**: Audio emotion classification per segment

### 4D. MBTI Estimation Engine ⭐ (NEW)
- **Endpoint**: `POST /analyze/mbti`
- **Input**: Aggregated results dari service 4A, 4B, 4C
- **Output**: `{ predicted_type, dimension_scores, confidence, reasoning }`
- Detail di section berikutnya

---

## Phase 5 — MBTI Estimation Engine (Detail)

### Konsep

MBTI diestimasi dari **sinyal behavioral** yang terekam selama interview. Ini bukan tes psikologi klinis, tapi **estimasi berbasis data multimodal**.

Setiap dimensi MBTI diprediksi secara independen (4 binary classification):

### Mapping Sinyal → Dimensi MBTI

#### E/I (Extraversion vs Introversion)
| Sinyal | Extravert (E) | Introvert (I) |
|---|---|---|
| Speaking rate (WPM) | Tinggi (>140 wpm) | Rendah (<120 wpm) |
| Voice energy (intensity) | Tinggi & konsisten | Rendah & bervariasi |
| Response latency | Cepat merespons | Jeda sebelum menjawab |
| Filler frequency | Sedikit filler | Lebih banyak filler (mikir dulu) |
| Ekspresi wajah | Ekspresif, sering tersenyum | Lebih netral/terkontrol |
| Pitch variation | Bervariasi (animated) | Lebih monoton |

#### S/N (Sensing vs Intuition)
| Sinyal | Sensing (S) | Intuition (N) |
|---|---|---|
| Kata konkret vs abstrak | Banyak kata konkret/detail | Banyak kata abstrak/konseptual |
| Panjang respons | Pendek, to the point | Panjang, eksplorasi ide |
| Filler pattern | Filler karena mikir fakta | Filler karena menyusun konsep |
| Speech structure | Linear, terstruktur | Non-linear, lompat-lompat |

#### T/F (Thinking vs Feeling)
| Sinyal | Thinking (T) | Feeling (F) |
|---|---|---|
| Ekspresi dominan | Netral, fokus | Bervariasi, empatik |
| Kata emosi dalam transkrip | Jarang | Sering |
| Pitch saat menjawab | Stabil | Naik-turun mengikuti emosi |
| Senyum frequency | Jarang | Sering |

#### J/P (Judging vs Perceiving)
| Sinyal | Judging (J) | Perceiving (P) |
|---|---|---|
| Speech structure | Rapi, terorganisir | Spontan, exploratif |
| Filler count | Rendah (sudah tahu mau bilang apa) | Lebih tinggi (improvisasi) |
| Response time | Konsisten | Bervariasi |
| Pause pattern | Pause terstruktur (antar poin) | Pause random |
| Speaking rate consistency | Stabil sepanjang interview | Bervariasi |

### Implementasi

```python
# Pseudocode - MBTI Estimation Engine

def estimate_mbti(expression_data, voice_data, transcript_data):
    scores = {}

    # E/I Dimension
    ei_signals = {
        'speaking_rate': calculate_wpm(transcript_data),
        'voice_energy': mean(voice_data.intensity),
        'expression_variety': count_unique_emotions(expression_data),
        'smile_ratio': calculate_smile_ratio(expression_data),
        'filler_rate': calculate_filler_rate(transcript_data),
        'pitch_variation': std(voice_data.pitch),
    }
    scores['E'], scores['I'] = ei_classifier(ei_signals)

    # S/N Dimension
    sn_signals = {
        'concrete_word_ratio': analyze_word_concreteness(transcript_data),
        'avg_response_length': mean_response_length(transcript_data),
        'speech_linearity': measure_topic_coherence(transcript_data),
    }
    scores['S'], scores['N'] = sn_classifier(sn_signals)

    # T/F Dimension
    tf_signals = {
        'emotion_word_count': count_emotion_words(transcript_data),
        'neutral_expression_ratio': calculate_neutral_ratio(expression_data),
        'pitch_emotion_correlation': correlate_pitch_emotion(voice_data),
        'smile_frequency': smile_per_minute(expression_data),
    }
    scores['T'], scores['F'] = tf_classifier(tf_signals)

    # J/P Dimension
    jp_signals = {
        'filler_count': total_fillers(transcript_data),
        'response_time_variance': var(response_times),
        'speaking_rate_consistency': consistency_score(transcript_data),
        'pause_regularity': measure_pause_pattern(voice_data),
    }
    scores['J'], scores['P'] = jp_classifier(jp_signals)

    predicted = pick_dominant_per_dimension(scores)
    return {
        'type': predicted,  # e.g. "ENFP"
        'scores': scores,
        'confidence': calculate_confidence(scores),
        'reasoning': generate_reasoning(scores, signals)
    }
```

### Pendekatan Bertahap
1. **V1 (Rule-based)**: Gunakan threshold/heuristic dari tabel mapping di atas. Cepat diimplementasi, akurasi ~50-60%.
2. **V2 (ML Classifier)**: Kumpulkan data interview + MBTI aktual → train classifier (XGBoost/Random Forest). Akurasi ~65-75%.
3. **V3 (Deep Learning)**: Fine-tune model multimodal (BERT + audio embeddings). Akurasi ~70-80%.

> ⚠️ **Disclaimer**: Estimasi MBTI dari behavioral signals adalah **perkiraan**, bukan diagnosis. Hasil harus ditampilkan dengan confidence level dan disclaimer yang jelas di UI.

---

## Phase 6 — Backend API (ElysiaJS)

### Endpoints

| Method | Path | Fungsi |
|---|---|---|
| `POST` | `/api/interviews/upload` | Upload video |
| `GET` | `/api/interviews` | List semua interview |
| `GET` | `/api/interviews/:id` | Detail + status |
| `GET` | `/api/interviews/:id/expressions` | Hasil ekspresi |
| `GET` | `/api/interviews/:id/voice` | Hasil analisis suara |
| `GET` | `/api/interviews/:id/transcript` | Transkrip + filler |
| `GET` | `/api/interviews/:id/mbti` | Hasil estimasi MBTI |
| `GET` | `/api/interviews/:id/summary` | Ringkasan keseluruhan |
| `POST` | `/api/interviews/:id/reanalyze` | Trigger ulang analisis |
| `DELETE` | `/api/interviews/:id` | Hapus interview |

### Tugas
1. Buat module structure per feature (controller, service, schema)
2. Validasi input dengan Elysia TypeBox
3. Error handling global
4. CORS untuk frontend

---

## Phase 7 — Frontend Dashboard

### Halaman

1. **Dashboard Home** — Overview semua interview, status, statistik
2. **Upload Page** — Drag & drop video + MediaPipe Face Mesh preview real-time
3. **Interview Detail** — Hasil analisis lengkap:
   - 📊 Expression timeline (emosi vs waktu)
   - 🎵 Voice chart (pitch contour, intensity)
   - 📝 Transcript viewer (filler words di-highlight merah)
   - 🧠 MBTI Card (tipe prediksi + breakdown per dimensi + confidence)
   - 📈 Summary card (skor keseluruhan + rekomendasi)
4. **MBTI Overview Page** — Distribusi MBTI semua kandidat, filter by intern/employee
5. **Comparison Page** — Bandingkan 2 interview side-by-side

### Komponen Kunci
- Video player dengan synced timeline
- Expression chart (line chart, gunakan Recharts/Chart.js)
- Pitch contour graph
- Filler word highlighter di transcript
- **MBTI Radar/Polar chart** — visualisasi 4 dimensi
- **MBTI Type Card** — tampilkan tipe dengan deskripsi singkat
- Score gauge chart

---

## Phase 8 — Scoring & Recommendations

### Overall Score Formula

```
Overall Score = (
    Expression Score × 0.25 +
    Voice Score      × 0.25 +
    Fluency Score    × 0.30 +
    Confidence Score × 0.20
)
```

- **Expression Score**: % waktu emosi positif (happy, neutral)
- **Voice Score**: Kestabilan pitch + energi vokal konsisten
- **Fluency Score**: 100 - (filler_percentage × multiplier), WPM dalam range ideal (120-150)
- **Confidence Score**: Derived dari posture, eye contact consistency, ekspresi stabil

### Auto-generated Recommendations
- Filler banyak → "Kurangi penggunaan kata 'anu' dan 'ehm'"
- Pitch monoton → "Variasikan intonasi agar lebih engaging"
- Ekspresi kaku → "Latih senyum natural dan kontak mata"
- MBTI-based → Saran komunikasi sesuai tipe prediksi

---

## Execution Order (Prioritas)

| Urutan | Phase | Estimasi |
|---|---|---|
| 1 | Phase 1 — Setup & Scaffolding | 1-2 hari |
| 2 | Phase 2 — Database Schema | 1 hari |
| 3 | Phase 4A-4C — AI Services (tanpa MBTI) | 3-5 hari |
| 4 | Phase 3 — Upload & Pipeline | 2-3 hari |
| 5 | Phase 6 — Backend API | 2-3 hari |
| 6 | Phase 7 — Frontend Dashboard (basic) | 3-5 hari |
| 7 | Phase 5 — MBTI Engine | 3-4 hari |
| 8 | Phase 8 — Scoring & Recommendations | 2 hari |
| 9 | Polish, testing, bug fixing | 2-3 hari |
| | **Total Estimasi** | **~20-28 hari** |

---

## Catatan Penting

> **MBTI Disclaimer**: Estimasi MBTI dari analisis behavioral bukan pengganti tes MBTI resmi. Hasil adalah estimasi berbasis pola komunikasi dan harus ditampilkan dengan confidence score serta disclaimer di UI.

> **GPU Requirement**: Whisper (medium/large) dan Wav2Vec membutuhkan GPU untuk kecepatan optimal. Untuk development, gunakan Whisper `base` atau `small`.

> **Privacy**: Video interview mengandung data sensitif. Implementasi proper access control dan data retention policy.
