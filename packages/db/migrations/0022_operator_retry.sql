ALTER TYPE "public"."approval_status" ADD VALUE 'SUPERSEDED';--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_decided_consistency";--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "retry_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_retry_generation_nonnegative" CHECK ("access_requests"."retry_generation" >= 0);--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_superseded_consistency" CHECK (("approvals"."status"::text = 'SUPERSEDED') = ("approvals"."superseded_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_consistency" CHECK (("approvals"."status"::text IN ('APPROVED', 'REJECTED')) = ("approvals"."decided_at" IS NOT NULL) AND ("approvals"."status"::text IN ('APPROVED', 'REJECTED')) = ("approvals"."decided_by_event_id" IS NOT NULL));