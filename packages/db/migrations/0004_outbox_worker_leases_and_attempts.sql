CREATE TYPE "public"."outbox_attempt_outcome" AS ENUM('SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'LEASE_EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'PROCESSED', 'DEAD_LETTERED');--> statement-breakpoint
CREATE TABLE "outbox_event_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbox_event_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"worker_id" text NOT NULL,
	"lease_token" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" "outbox_attempt_outcome",
	"error" text,
	"detail" jsonb,
	CONSTRAINT "outbox_event_attempts_lease_token_unique" UNIQUE("lease_token"),
	CONSTRAINT "outbox_event_attempts_outcome_iff_finished" CHECK (("outbox_event_attempts"."outcome" IS NULL) = ("outbox_event_attempts"."finished_at" IS NULL))
);
--> statement-breakpoint
DROP INDEX "outbox_events_unpublished_idx";--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "status" "outbox_status" DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "cycle_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "dead_lettered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "redrive_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_event_attempts" ADD CONSTRAINT "outbox_event_attempts_outbox_event_id_outbox_events_id_fk" FOREIGN KEY ("outbox_event_id") REFERENCES "public"."outbox_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_event_attempts_event_attempt_idx" ON "outbox_event_attempts" USING btree ("outbox_event_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_idempotency_key_idx" ON "audit_events" USING btree ("idempotency_key") WHERE "audit_events"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "outbox_events_claimable_idx" ON "outbox_events" USING btree ("available_at") WHERE "outbox_events"."status" = 'PENDING';--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_cycle_attempts_valid" CHECK ("outbox_events"."cycle_attempts" >= 0 AND "outbox_events"."cycle_attempts" <= "outbox_events"."attempts");--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_published_iff_processed" CHECK (("outbox_events"."status" = 'PROCESSED') = ("outbox_events"."published_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_dead_lettered_iff_status" CHECK (("outbox_events"."status" = 'DEAD_LETTERED') = ("outbox_events"."dead_lettered_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_lease_all_or_nothing" CHECK (("outbox_events"."lease_token" IS NULL) = ("outbox_events"."lease_owner" IS NULL) AND ("outbox_events"."lease_token" IS NULL) = ("outbox_events"."lease_expires_at" IS NULL));--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_lease_only_when_pending" CHECK ("outbox_events"."lease_token" IS NULL OR "outbox_events"."status" = 'PENDING');