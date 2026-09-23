CREATE TABLE "hris_event_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"hris_employee_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_created" boolean NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hris_event_receipts_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"correlation_id" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "outbox_events_attempts_non_negative" CHECK ("outbox_events"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "hris_event_receipts" ADD CONSTRAINT "hris_event_receipts_workflow_id_onboarding_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."onboarding_workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hris_event_receipts_workflow_id_idx" ON "hris_event_receipts" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("available_at") WHERE "outbox_events"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "outbox_events_aggregate_idx" ON "outbox_events" USING btree ("aggregate_type","aggregate_id");