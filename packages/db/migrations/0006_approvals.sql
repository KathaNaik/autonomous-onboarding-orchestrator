CREATE TYPE "public"."approval_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."callback_event_status" AS ENUM('RECEIVED', 'PROCESSED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "approval_callback_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "external_provider" NOT NULL,
	"event_id" text NOT NULL,
	"external_id" text NOT NULL,
	"external_reference" text NOT NULL,
	"correlation_key" text NOT NULL,
	"claimed_state" text,
	"payload_sha256" text NOT NULL,
	"status" "callback_event_status" DEFAULT 'RECEIVED' NOT NULL,
	"outcome" text,
	"outcome_detail" jsonb,
	"approval_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "approval_callback_events_processed_consistency" CHECK (("approval_callback_events"."status" = 'RECEIVED') = ("approval_callback_events"."processed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"external_operation_id" uuid NOT NULL,
	"provider" "external_provider" NOT NULL,
	"correlation_key" text NOT NULL,
	"external_id" text NOT NULL,
	"external_reference" text NOT NULL,
	"status" "approval_status" DEFAULT 'PENDING' NOT NULL,
	"provider_state" text,
	"verified_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by_event_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_external_operation_id_unique" UNIQUE("external_operation_id"),
	CONSTRAINT "approvals_decided_consistency" CHECK (("approvals"."status" = 'PENDING') = ("approvals"."decided_at" IS NULL) AND ("approvals"."status" = 'PENDING') = ("approvals"."decided_by_event_id" IS NULL)),
	CONSTRAINT "approvals_version_positive" CHECK ("approvals"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "approval_callback_events" ADD CONSTRAINT "approval_callback_events_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workflow_id_onboarding_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."onboarding_workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_external_operation_id_external_operations_id_fk" FOREIGN KEY ("external_operation_id") REFERENCES "public"."external_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_callback_events_provider_event_idx" ON "approval_callback_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "approval_callback_events_correlation_idx" ON "approval_callback_events" USING btree ("provider","correlation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_provider_correlation_idx" ON "approvals" USING btree ("provider","correlation_key");--> statement-breakpoint
CREATE INDEX "approvals_workflow_id_idx" ON "approvals" USING btree ("workflow_id");