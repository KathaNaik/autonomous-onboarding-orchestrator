CREATE TYPE "public"."external_operation_status" AS ENUM('PENDING', 'IN_PROGRESS', 'OUTCOME_UNKNOWN', 'SUCCEEDED', 'FAILED', 'CONFLICT');--> statement-breakpoint
CREATE TYPE "public"."external_provider" AS ENUM('servicenow', 'okta', 'github');--> statement-breakpoint
CREATE TABLE "external_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"provider" "external_provider" NOT NULL,
	"operation_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"correlation_key" text NOT NULL,
	"request" jsonb NOT NULL,
	"request_sha256" text NOT NULL,
	"status" "external_operation_status" DEFAULT 'PENDING' NOT NULL,
	"external_id" text,
	"external_reference" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_error_detail" jsonb,
	"evidence" jsonb,
	"owner_token" uuid,
	"owner_id" text,
	"owner_expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_operations_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "external_operations_attempts_non_negative" CHECK ("external_operations"."attempts" >= 0),
	CONSTRAINT "external_operations_owner_all_or_nothing" CHECK (("external_operations"."owner_token" IS NULL) = ("external_operations"."owner_id" IS NULL) AND ("external_operations"."owner_token" IS NULL) = ("external_operations"."owner_expires_at" IS NULL)),
	CONSTRAINT "external_operations_owner_only_while_active" CHECK ("external_operations"."owner_token" IS NULL OR "external_operations"."status" IN ('IN_PROGRESS', 'OUTCOME_UNKNOWN')),
	CONSTRAINT "external_operations_in_progress_has_owner" CHECK ("external_operations"."status" <> 'IN_PROGRESS' OR "external_operations"."owner_token" IS NOT NULL),
	CONSTRAINT "external_operations_succeeded_is_complete" CHECK ("external_operations"."status" <> 'SUCCEEDED' OR ("external_operations"."external_id" IS NOT NULL AND "external_operations"."external_reference" IS NOT NULL AND "external_operations"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "external_operations" ADD CONSTRAINT "external_operations_workflow_id_onboarding_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."onboarding_workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_operations_provider_correlation_idx" ON "external_operations" USING btree ("provider","correlation_key");--> statement-breakpoint
CREATE INDEX "external_operations_workflow_id_idx" ON "external_operations" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "external_operations_status_idx" ON "external_operations" USING btree ("status");