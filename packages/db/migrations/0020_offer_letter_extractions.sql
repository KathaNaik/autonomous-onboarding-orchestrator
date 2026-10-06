CREATE TYPE "public"."offer_letter_extraction_status" AS ENUM('EXTRACTED', 'SUBMITTED');--> statement-breakpoint
CREATE TABLE "offer_letter_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "offer_letter_extraction_status" DEFAULT 'EXTRACTED' NOT NULL,
	"file_sha256" text NOT NULL,
	"file_bytes" integer NOT NULL,
	"uploaded_by" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model_provider" text NOT NULL,
	"model" text NOT NULL,
	"model_config" text NOT NULL,
	"served_model" text,
	"provider_response_id" text,
	"model_calls" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"proposal" jsonb NOT NULL,
	"confirmed" jsonb,
	"submitted_by" text,
	"hris_event_id" text,
	"workflow_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"submitted_at" timestamp with time zone,
	CONSTRAINT "offer_letter_extractions_hris_event_id_unique" UNIQUE("hris_event_id"),
	CONSTRAINT "offer_letter_extractions_submitted_chk" CHECK (("offer_letter_extractions"."status" = 'SUBMITTED') = ("offer_letter_extractions"."workflow_id" IS NOT NULL AND "offer_letter_extractions"."submitted_at" IS NOT NULL AND "offer_letter_extractions"."submitted_by" IS NOT NULL AND "offer_letter_extractions"."confirmed" IS NOT NULL AND "offer_letter_extractions"."hris_event_id" IS NOT NULL)),
	CONSTRAINT "offer_letter_extractions_size_chk" CHECK ("offer_letter_extractions"."file_bytes" > 0 AND "offer_letter_extractions"."file_bytes" <= 4194304)
);
--> statement-breakpoint
ALTER TABLE "offer_letter_extractions" ADD CONSTRAINT "offer_letter_extractions_workflow_id_onboarding_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."onboarding_workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offer_letter_extractions_created_idx" ON "offer_letter_extractions" USING btree ("created_at");