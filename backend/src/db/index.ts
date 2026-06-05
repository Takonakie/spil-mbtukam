import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:1234@localhost:5432/interview_analyzer';

const pool = new Pool({
  connectionString
});

export const db = drizzle(pool, { schema });
