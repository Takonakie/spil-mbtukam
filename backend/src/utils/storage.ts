import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const UPLOADS_DIR = join(process.cwd(), 'uploads');
export const VIDEOS_DIR = join(UPLOADS_DIR, 'videos');
export const AUDIOS_DIR = join(UPLOADS_DIR, 'audios');

export async function ensureUploadDirectories() {
  try {
    if (!existsSync(UPLOADS_DIR)) {
      await mkdir(UPLOADS_DIR, { recursive: true });
    }
    if (!existsSync(VIDEOS_DIR)) {
      await mkdir(VIDEOS_DIR, { recursive: true });
    }
    if (!existsSync(AUDIOS_DIR)) {
      await mkdir(AUDIOS_DIR, { recursive: true });
    }
    console.log('📁 Upload directories verified/created.');
  } catch (error) {
    console.error('Error creating upload directories:', error);
  }
}
