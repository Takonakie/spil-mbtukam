import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, existsSync } from 'node:fs';

const execPromise = promisify(exec);
const copyFilePromise = promisify(copyFile);

export async function extractAudioFromVideo(videoPath: string, audioPath: string): Promise<boolean> {
  try {
    console.log(`🎵 Extracting audio from ${videoPath} to ${audioPath}...`);
    
    // Check if ffmpeg is available
    let hasFfmpeg = false;
    try {
      await execPromise('ffmpeg -version');
      hasFfmpeg = true;
    } catch (e) {
      console.warn('⚠️ ffmpeg is not installed on the system. Falling back...');
    }

    if (hasFfmpeg) {
      // Run ffmpeg command: extract audio to 16kHz mono wav
      await execPromise(`ffmpeg -y -i "${videoPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${audioPath}"`);
      console.log('✅ Audio extraction complete using local ffmpeg.');
      return true;
    } else {
      // Resilient fallback: Since Python services can read video files directly (or extract audio natively),
      // we copy the video file as placeholders or pass the video path. For local files, we just copy.
      // In a production setup, we can let the AI service handle the direct video path.
      console.log('ℹ️ Local ffmpeg not found. The pipeline will let Python AI services read the video directly.');
      return false;
    }
  } catch (error) {
    console.error('❌ Audio extraction failed:', error);
    return false;
  }
}
