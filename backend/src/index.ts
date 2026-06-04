import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { join } from 'node:path';
import { db } from './db/index.ts';
import { 
  interviewsTable, 
  analysisSummaryTable, 
  expressionResultsTable, 
  voiceResultsTable, 
  transcriptSegmentsTable, 
  mbtiResultsTable 
} from './db/schema.ts';
import { eq, desc } from 'drizzle-orm';
import { ensureUploadDirectories, VIDEOS_DIR, AUDIOS_DIR } from './utils/storage.ts';
import { processInterviewPipeline } from './utils/pipeline.ts';

// Initialize storage directories
ensureUploadDirectories().catch(err => {
  console.error("Failed to initialize upload directories:", err);
});

const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, VIDEOS_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

// 1. Upload Interview Video
app.post('/api/interviews/upload', upload.single('video'), async (req: any, res: any) => {
  try {
    const { candidateName, candidateType } = req.body;
    const video = req.file;
    
    if (!video) {
      return res.status(400).json({ error: 'Video file is required' });
    }
    
    const filename = video.filename;
    const filepath = video.path;
    
    console.log(`📥 Saving uploaded video to ${filepath}...`);
    console.log(`💾 Inserting interview record for ${candidateName}...`);
    
    const [interview] = await db.insert(interviewsTable).values({
      candidateName,
      candidateType: candidateType as 'intern' | 'employee',
      videoUrl: filepath,
      status: 'uploaded'
    }).returning();
    
    // Fire-and-forget: Trigger background AI processing pipeline
    processInterviewPipeline(interview.id, filename);
    
    return res.json({
      message: 'Video uploaded and analysis started successfully',
      interviewId: interview.id,
      status: 'uploaded'
    });
  } catch (error: any) {
    console.error('Error handling upload:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// 2. List All Interviews
app.get('/api/interviews', async (req, res) => {
  try {
    const interviews = await db.select()
      .from(interviewsTable)
      .orderBy(desc(interviewsTable.createdAt));
      
    // Fetch summaries for each to include the overall score if available
    const results = await Promise.all(interviews.map(async (interview) => {
      const [summary] = await db.select()
        .from(analysisSummaryTable)
        .where(eq(analysisSummaryTable.interviewId, interview.id))
        .limit(1);
        
      const videoFilename = interview.videoUrl.split(/[/\\]/).pop();
      const videoWebUrl = videoFilename ? `http://localhost:3001/api/files/videos/${videoFilename}` : null;
      return {
        ...interview,
        videoWebUrl,
        overallScore: summary?.overallScore || null,
        dominantEmotion: summary?.dominantEmotion || null,
        mbtiType: summary?.mbtiType || null
      };
    }));
    
    res.json(results);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Get Interview Detail
app.get('/api/interviews/:id', async (req: any, res: any) => {
  try {
    const { id } = req.params;
    
    const [interview] = await db.select()
      .from(interviewsTable)
      .where(eq(interviewsTable.id, id))
      .limit(1);
      
    if (!interview) {
      return res.status(404).json({ error: 'Interview not found' });
    }
    
    const [summary] = await db.select()
      .from(analysisSummaryTable)
      .where(eq(analysisSummaryTable.interviewId, id))
      .limit(1);
      
    const [mbti] = await db.select()
      .from(mbtiResultsTable)
      .where(eq(mbtiResultsTable.interviewId, id))
      .limit(1);
      
    const videoFilename = interview.videoUrl.split(/[/\\]/).pop();
    const videoWebUrl = videoFilename ? `http://localhost:3001/api/files/videos/${videoFilename}` : null;
    return res.json({
      ...interview,
      videoWebUrl,
      summary: summary || null,
      mbti: mbti || null
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// 4. Get Expressions Results
app.get('/api/interviews/:id/expressions', async (req, res) => {
  try {
    const results = await db.select()
      .from(expressionResultsTable)
      .where(eq(expressionResultsTable.interviewId, req.params.id))
      .orderBy(expressionResultsTable.timestampSec);
    res.json(results);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Get Voice Results
app.get('/api/interviews/:id/voice', async (req, res) => {
  try {
    const results = await db.select()
      .from(voiceResultsTable)
      .where(eq(voiceResultsTable.interviewId, req.params.id))
      .orderBy(voiceResultsTable.timestampSec);
    res.json(results);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Get Transcript Results
app.get('/api/interviews/:id/transcript', async (req, res) => {
  try {
    const results = await db.select()
      .from(transcriptSegmentsTable)
      .where(eq(transcriptSegmentsTable.interviewId, req.params.id))
      .orderBy(transcriptSegmentsTable.startTime);
    res.json(results);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 7. Get MBTI Detail
app.get('/api/interviews/:id/mbti', async (req: any, res: any) => {
  try {
    const [mbti] = await db.select()
      .from(mbtiResultsTable)
      .where(eq(mbtiResultsTable.interviewId, req.params.id))
      .limit(1);
    if (!mbti) {
      return res.status(404).json({ error: 'MBTI results not found for this interview' });
    }
    return res.json(mbti);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// 8. Delete Interview and all cascade data
app.delete('/api/interviews/:id', async (req, res) => {
  try {
    await db.delete(interviewsTable)
      .where(eq(interviewsTable.id, req.params.id));
    res.json({ message: 'Interview deleted successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Serve uploaded files statically
app.use('/api/files/videos', express.static(VIDEOS_DIR));
app.use('/api/files/audios', express.static(AUDIOS_DIR));

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`⚡ Interview Analyzer API is running at http://localhost:${PORT}`);
});
