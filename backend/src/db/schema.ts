import { pgTable, uuid, varchar, integer, doublePrecision, boolean, text, jsonb, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Enums
export const candidateTypeEnum = pgEnum('candidate_type', ['intern', 'employee']);
export const statusEnum = pgEnum('status', ['uploaded', 'processing', 'completed', 'failed']);

// 1. Interviews Table
export const interviewsTable = pgTable('interviews', {
  id: uuid('id').defaultRandom().primaryKey(),
  candidateName: varchar('candidate_name', { length: 255 }).notNull(),
  candidateType: candidateTypeEnum('candidate_type').notNull(),
  videoUrl: varchar('video_url', { length: 1024 }).notNull(),
  audioUrl: varchar('audio_url', { length: 1024 }),
  durationSeconds: integer('duration_seconds'),
  status: statusEnum('status').default('uploaded').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

// 2. Expression Results Table
export const expressionResultsTable = pgTable('expression_results', {
  id: uuid('id').defaultRandom().primaryKey(),
  interviewId: uuid('interview_id').references(() => interviewsTable.id, { onDelete: 'cascade' }).notNull(),
  timestampSec: doublePrecision('timestamp_sec').notNull(),
  emotion: varchar('emotion', { length: 50 }).notNull(),
  confidence: doublePrecision('confidence').notNull()
});

// 3. Voice Results Table
export const voiceResultsTable = pgTable('voice_results', {
  id: uuid('id').defaultRandom().primaryKey(),
  interviewId: uuid('interview_id').references(() => interviewsTable.id, { onDelete: 'cascade' }).notNull(),
  timestampSec: doublePrecision('timestamp_sec').notNull(),
  pitchHz: doublePrecision('pitch_hz'),
  intensityDb: doublePrecision('intensity_db'),
  jitter: doublePrecision('jitter'),
  shimmer: doublePrecision('shimmer'),
  hnr: doublePrecision('hnr'),
  audioEmotion: varchar('audio_emotion', { length: 50 })
});

// 4. Transcript Segments Table
export const transcriptSegmentsTable = pgTable('transcript_segments', {
  id: uuid('id').defaultRandom().primaryKey(),
  interviewId: uuid('interview_id').references(() => interviewsTable.id, { onDelete: 'cascade' }).notNull(),
  startTime: doublePrecision('start_time').notNull(),
  endTime: doublePrecision('end_time').notNull(),
  text: text('text').notNull(),
  isFiller: boolean('is_filler').default(false).notNull(),
  fillerType: varchar('filler_type', { length: 50 }),
  fillerCount: integer('filler_count').default(0).notNull(),
  pauseBeforeSec: doublePrecision('pause_before_sec').default(0).notNull(),
  speaker: varchar('speaker', { length: 50 }).default('candidate').notNull(),
  speechAct: varchar('speech_act', { length: 50 }).default('statement').notNull()
});

// 5. MBTI Results Table
export const mbtiResultsTable = pgTable('mbti_results', {
  id: uuid('id').defaultRandom().primaryKey(),
  interviewId: uuid('interview_id').references(() => interviewsTable.id, { onDelete: 'cascade' }).notNull(),
  predictedType: varchar('predicted_type', { length: 4 }).notNull(), // e.g. "ENFP"
  eScore: doublePrecision('e_score').notNull(),
  iScore: doublePrecision('i_score').notNull(),
  sScore: doublePrecision('s_score').notNull(),
  nScore: doublePrecision('n_score').notNull(),
  tScore: doublePrecision('t_score').notNull(),
  fScore: doublePrecision('f_score').notNull(),
  jScore: doublePrecision('j_score').notNull(),
  pScore: doublePrecision('p_score').notNull(),
  confidence: doublePrecision('confidence').notNull(),
  reasoning: jsonb('reasoning').notNull() // Explanations per dimension
});

// 6. Analysis Summary Table
export const analysisSummaryTable = pgTable('analysis_summary', {
  id: uuid('id').defaultRandom().primaryKey(),
  interviewId: uuid('interview_id').references(() => interviewsTable.id, { onDelete: 'cascade' }).notNull(),
  dominantEmotion: varchar('dominant_emotion', { length: 50 }),
  emotionStabilityScore: doublePrecision('emotion_stability_score'),
  avgPitchHz: doublePrecision('avg_pitch_hz'),
  pitchVariation: doublePrecision('pitch_variation'),
  speakingRateWpm: doublePrecision('speaking_rate_wpm'),
  fillerCount: integer('filler_count'),
  fillerPercentage: doublePrecision('filler_percentage'),
  mbtiType: varchar('mbti_type', { length: 4 }),
  overallScore: doublePrecision('overall_score'),
  recommendations: jsonb('recommendations'),
  executiveSummary: text('executive_summary')
});

// Relations
export const interviewsRelations = relations(interviewsTable, ({ many, one }) => ({
  expressions: many(expressionResultsTable),
  voices: many(voiceResultsTable),
  transcripts: many(transcriptSegmentsTable),
  mbti: one(mbtiResultsTable, {
    fields: [interviewsTable.id],
    references: [mbtiResultsTable.interviewId]
  }),
  summary: one(analysisSummaryTable, {
    fields: [interviewsTable.id],
    references: [analysisSummaryTable.interviewId]
  })
}));

export const expressionResultsRelations = relations(expressionResultsTable, ({ one }) => ({
  interview: one(interviewsTable, {
    fields: [expressionResultsTable.interviewId],
    references: [interviewsTable.id]
  })
}));

export const voiceResultsRelations = relations(voiceResultsTable, ({ one }) => ({
  interview: one(interviewsTable, {
    fields: [voiceResultsTable.interviewId],
    references: [interviewsTable.id]
  })
}));

export const transcriptSegmentsRelations = relations(transcriptSegmentsTable, ({ one }) => ({
  interview: one(interviewsTable, {
    fields: [transcriptSegmentsTable.interviewId],
    references: [interviewsTable.id]
  })
}));

export const mbtiResultsRelations = relations(mbtiResultsTable, ({ one }) => ({
  interview: one(interviewsTable, {
    fields: [mbtiResultsTable.interviewId],
    references: [interviewsTable.id]
  })
}));

export const analysisSummaryRelations = relations(analysisSummaryTable, ({ one }) => ({
  interview: one(interviewsTable, {
    fields: [analysisSummaryTable.interviewId],
    references: [interviewsTable.id]
  })
}));
