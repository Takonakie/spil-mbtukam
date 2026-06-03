# 🚀 Interview Analyzer — Getting Started Guide

Aplikasi analisis interview multimodal untuk mengekstrak ekspresi wajah, kualitas vokal, transkrip dengan deteksi *filler words*, serta estimasi tipe kepribadian MBTI.

---

## Prasyarat (Requirements)

Pastikan dependensi berikut terinstal di komputer Anda:
1. **Node.js & npm** (Atau **Bun** jika ingin kecepatan optimal. Panduan ini menggunakan Bun karena ia adalah runtime default yang telah dikonfigurasi).
2. **Python 3.12+**
3. **PostgreSQL** (Berjalan secara native pada port `5432` dengan password `your_password_here`).
4. **FFmpeg** (Opsional, untuk ekstraksi audio otomatis lokal. Jika tidak ada, sistem akan otomatis menggunakan fallback video path langsung ke AI service).

---

## Cara Menjalankan Aplikasi (Langkah demi Langkah)

Untuk menjalankan seluruh ekosistem aplikasi secara lokal, buka **3 terminal berbeda** (atau tab PowerShell) dan ikuti langkah di bawah ini:

### 1. Jalankan Backend API (ElysiaJS)

ElysiaJS berfungsi sebagai API Gateway utama yang menerima upload video, mengelola database PostgreSQL (via Drizzle ORM), dan mengoordinasikan pipeline asinkron.

Di terminal pertama, jalankan perintah berikut:
```bash
cd backend
bun install
bun run dev
```
*Server backend akan berjalan di: **`http://localhost:3001`***

---

### 2. Jalankan Python AI Microservices (FastAPI)

FastAPI menginang semua model pemrosesan AI (DeepFace, OpenAI Whisper, Praat parselmouth, YAMNet/Wav2Vec, dan MBTI Estimation Engine).

Di terminal kedua, jalankan perintah berikut untuk membuat virtual environment, menginstal dependensi, dan menjalankan server:

**Di Windows (PowerShell/CMD):**
```powershell
cd ai-services
python -m venv venv
venv\Scripts\pip install -r requirements.txt
venv\Scripts\python -m uvicorn services.main:app --host 127.0.0.1 --port 8000
```

**Di macOS / Linux:**
```bash
cd ai-services
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python -m uvicorn services.main:app --host 127.0.0.1 --port 8000
```
*Server AI microservices akan berjalan di: **`http://localhost:8000`***

---

### 3. Jalankan Frontend Dashboard (Vite + React)

Dashboard UI interaktif untuk melakukan drag & drop upload video interview kandidat, melihat statistik, timeline emosi, grafik pitch suara, transkrip yang di-highlight, dan ringkasan MBTI.

Di terminal ketiga, jalankan perintah berikut:
```bash
cd frontend
bun install
bun run dev
```
*Frontend akan berjalan di: **`http://localhost:5173`*** (atau port dinamis berikutnya yang ditampilkan di layar).

---

## 🛠️ Perintah Berguna Lainnya (Database & Drizzle)

Jika Anda melakukan perubahan pada skema database (`backend/src/db/schema.ts`):

- **Menghasilkan file SQL migrasi baru**:
  ```bash
  cd backend
  bun run db:generate
  ```

- **Mendorong perubahan skema langsung ke PostgreSQL**:
  ```bash
  cd backend
  bun run db:push
  ```

- **Membuka Drizzle Studio (UI Database Inspector)**:
  ```bash
  cd backend
  bun run db:studio
  ```

