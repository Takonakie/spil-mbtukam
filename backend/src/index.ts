import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
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
await ensureUploadDirectories();

const app = new Elysia()
  .use(cors())
  
  // Health check endpoint
  .get('/health', () => ({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  }))
  
  // 1. Upload Interview Video
  .post('/api/interviews/upload', async ({ body, set }) => {
    try {
      const { candidateName, candidateType, video } = body;
      
      if (!video) {
        set.status = 400;
        return { error: 'Video file is required' };
      }
      
      const filename = `${Date.now()}-${video.name}`;
      const filepath = join(VIDEOS_DIR, filename);
      
      console.log(`📥 Saving uploaded video to ${filepath}...`);
      await Bun.write(filepath, video);
      
      console.log(`💾 Inserting interview record for ${candidateName}...`);
      const [interview] = await db.insert(interviewsTable).values({
        candidateName,
        candidateType: candidateType as 'intern' | 'employee',
        videoUrl: filepath,
        status: 'uploaded'
      }).returning();
      
      // Fire-and-forget: Trigger background AI processing pipeline
      processInterviewPipeline(interview.id, filename);
      
      return {
        message: 'Video uploaded and analysis started successfully',
        interviewId: interview.id,
        status: 'uploaded'
      };
    } catch (error: any) {
      console.error('Error handling upload:', error);
      set.status = 500;
      return { error: error.message || 'Internal server error' };
    }
  }, {
    body: t.Object({
      candidateName: t.String(),
      candidateType: t.String(), // 'intern' | 'employee'
      video: t.File()
    })
  })
  
  // 2. List All Interviews
  .get('/api/interviews', async () => {
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
      
      return results;
    } catch (error: any) {
      return { error: error.message };
    }
  })
  
  // 3. Get Interview Detail
  .get('/api/interviews/:id', async ({ params, set }) => {
    try {
      const { id } = params;
      
      const [interview] = await db.select()
        .from(interviewsTable)
        .where(eq(interviewsTable.id, id))
        .limit(1);
        
      if (!interview) {
        set.status = 404;
        return { error: 'Interview not found' };
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
      return {
        ...interview,
        videoWebUrl,
        summary: summary || null,
        mbti: mbti || null
      };
    } catch (error: any) {
      set.status = 500;
      return { error: error.message };
    }
  })
  
  // 4. Get Expressions Results
  .get('/api/interviews/:id/expressions', async ({ params, set }) => {
    try {
      const results = await db.select()
        .from(expressionResultsTable)
        .where(eq(expressionResultsTable.interviewId, params.id))
        .orderBy(expressionResultsTable.timestampSec);
      return results;
    } catch (error: any) {
      set.status = 500;
      return { error: error.message };
    }
  })
  
  // 5. Get Voice Results
  .get('/api/interviews/:id/voice', async ({ params, set }) => {
    try {
      const results = await db.select()
        .from(voiceResultsTable)
        .where(eq(voiceResultsTable.interviewId, params.id))
        .orderBy(voiceResultsTable.timestampSec);
      return results;
    } catch (error: any) {
      set.status = 500;
      return { error: error.message };
    }
  })
  
  // 6. Get Transcript Results
  .get('/api/interviews/:id/transcript', async ({ params, set }) => {
    try {
      const results = await db.select()
        .from(transcriptSegmentsTable)
        .where(eq(transcriptSegmentsTable.interviewId, params.id))
        .orderBy(transcriptSegmentsTable.startTime);
      return results;
    } catch (error: any) {
      set.status = 500;
      return { error: error.message };
    }
  })

  // 7. Get MBTI Detail
  .get('/api/interviews/:id/mbti', async ({ params, set }) => {
    try {
      const [mbti] = await db.select()
        .from(mbtiResultsTable)
        .where(eq(mbtiResultsTable.interviewId, params.id))
        .limit(1);
      if (!mbti) {
        set.status = 404;
        return { error: 'MBTI results not found for this interview' };
      }
      return mbti;
    } catch (error: any) {
      set.status = 500;
      return { error: error.message };
    }
  })
  
  // 8. Delete Interview and all cascade data
  .delete('/api/interviews/:id', async ({ params, set }) => {
    try {
      await db.delete(interviewsTable)
        .where(eq(interviewsTable.id, params.id));
      return { message: 'Interview deleted successfully' };
    } catch (error: any) {
      set.status = 500;
      return { error: error.message };
    }
  })
  
  // Serve uploaded video and audio files statically
  .get('/api/files/videos/:filename', ({ params }) => {
    return Bun.file(join(VIDEOS_DIR, params.filename));
  })
  .get('/api/files/audios/:filename', ({ params }) => {
    return Bun.file(join(AUDIOS_DIR, params.filename));
  })
  
  .listen(3001);

console.log(
  `⚡ Interview Analyzer API is running at http://${app.server?.hostname}:${app.server?.port}`
);
