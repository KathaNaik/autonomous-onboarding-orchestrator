CREATE TYPE "public"."provisioning_plan_status" AS ENUM('ACTIVE', 'COMPLETE');--> statement-breakpoint
ALTER TYPE "public"."access_request_status" ADD VALUE 'MANUAL_ACTION_REQUIRED';--> statement-breakpoint
CREATE TABLE "workflow_provisioning_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"catalog_version" text NOT NULL,
	"catalog_hash" text NOT NULL,
	"policy_version" text NOT NULL,
	"policy_hash" text NOT NULL,
	"status" "provisioning_plan_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_via" text NOT NULL,
	"last_coordinated_at" timestamp with time zone,
	"next_reconcile_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_provisioning_plans_completed_iff_complete" CHECK (("workflow_provisioning_plans"."status" = 'COMPLETE') = ("workflow_provisioning_plans"."completed_at" IS NOT NULL)),
	CONSTRAINT "workflow_provisioning_plans_created_via_valid" CHECK ("workflow_provisioning_plans"."created_via" IN ('AUTHORIZATION', 'LEGACY_ADOPTION'))
);
--> statement-breakpoint
ALTER TABLE "access_requests" DROP CONSTRAINT "access_requests_authorized_via_iff_authorized";--> statement-breakpoint
ALTER TABLE "access_requests" DROP CONSTRAINT "access_requests_provisioned_has_evidence";--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "orchestration_blocker" text;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "blocker_class" text;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "next_reconcile_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "last_coordinated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "manual_completed_by" text;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "manual_evidence" text;--> statement-breakpoint
ALTER TABLE "workflow_provisioning_plans" ADD CONSTRAINT "workflow_provisioning_plans_workflow_id_onboarding_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."onboarding_workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_provisioning_plans" ADD CONSTRAINT "workflow_provisioning_plans_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_provisioning_plans_one_active_idx" ON "workflow_provisioning_plans" USING btree ("workflow_id") WHERE "workflow_provisioning_plans"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_provisioning_plans_workflow_run_idx" ON "workflow_provisioning_plans" USING btree ("workflow_id","agent_run_id");--> statement-breakpoint
CREATE INDEX "workflow_provisioning_plans_next_reconcile_idx" ON "workflow_provisioning_plans" USING btree ("next_reconcile_at") WHERE "workflow_provisioning_plans"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "access_requests_next_reconcile_idx" ON "access_requests" USING btree ("next_reconcile_at") WHERE "access_requests"."next_reconcile_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_blocker_class_valid" CHECK ("access_requests"."blocker_class" IS NULL OR "access_requests"."blocker_class" IN ('WAITING', 'RETRYABLE', 'MANUAL', 'DETERMINISTIC_FAILURE'));--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_blocker_pair" CHECK (("access_requests"."orchestration_blocker" IS NULL) = ("access_requests"."blocker_class" IS NULL));--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_manual_evidence_pair" CHECK (("access_requests"."manual_completed_by" IS NULL) = ("access_requests"."manual_evidence" IS NULL));--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_authorized_via_iff_authorized" CHECK (("access_requests"."status"::text IN ('READY_FOR_PROVISIONING', 'PROVISIONING', 'PROVISIONED', 'PROVISIONING_FAILED', 'MANUAL_ACTION_REQUIRED')) = ("access_requests"."authorized_via" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_provisioned_has_evidence" CHECK ("access_requests"."status"::text <> 'PROVISIONED' OR ("access_requests"."provisioned_at" IS NOT NULL AND (("access_requests"."provisioning_operation_id" IS NOT NULL AND "access_requests"."provider_subject_id" IS NOT NULL AND "access_requests"."provider_target_id" IS NOT NULL) OR ("access_requests"."manual_completed_by" IS NOT NULL AND "access_requests"."manual_evidence" IS NOT NULL))));