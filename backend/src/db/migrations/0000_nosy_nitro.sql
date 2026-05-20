DO $$ BEGIN
 CREATE TYPE "candidate_type" AS ENUM('intern', 'employee');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "status" AS ENUM('uploaded', 'processing', 'completed', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analysis_summary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interview_id" uuid NOT NULL,
	"dominant_emotion" varchar(50),
	"emotion_stability_score" double precision,
	"avg_pitch_hz" double precision,
	"pitch_variation" double precision,
	"speaking_rate_wpm" double precision,
	"filler_count" integer,
	"filler_percentage" double precision,
	"mbti_type" varchar(4),
	"overall_score" double precision,
	"recommendations" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "expression_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interview_id" uuid NOT NULL,
	"timestamp_sec" double precision NOT NULL,
	"emotion" varchar(50) NOT NULL,
	"confidence" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "interviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_name" varchar(255) NOT NULL,
	"candidate_type" "candidate_type" NOT NULL,
	"video_url" varchar(1024) NOT NULL,
	"audio_url" varchar(1024),
	"duration_seconds" integer,
	"status" "status" DEFAULT 'uploaded' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mbti_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interview_id" uuid NOT NULL,
	"predicted_type" varchar(4) NOT NULL,
	"e_score" double precision NOT NULL,
	"i_score" double precision NOT NULL,
	"s_score" double precision NOT NULL,
	"n_score" double precision NOT NULL,
	"t_score" double precision NOT NULL,
	"f_score" double precision NOT NULL,
	"j_score" double precision NOT NULL,
	"p_score" double precision NOT NULL,
	"confidence" double precision NOT NULL,
	"reasoning" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transcript_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interview_id" uuid NOT NULL,
	"start_time" double precision NOT NULL,
	"end_time" double precision NOT NULL,
	"text" text NOT NULL,
	"is_filler" boolean DEFAULT false NOT NULL,
	"filler_type" varchar(50)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interview_id" uuid NOT NULL,
	"timestamp_sec" double precision NOT NULL,
	"pitch_hz" double precision,
	"intensity_db" double precision,
	"jitter" double precision,
	"shimmer" double precision,
	"hnr" double precision,
	"audio_emotion" varchar(50)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "analysis_summary" ADD CONSTRAINT "analysis_summary_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expression_results" ADD CONSTRAINT "expression_results_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mbti_results" ADD CONSTRAINT "mbti_results_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voice_results" ADD CONSTRAINT "voice_results_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
