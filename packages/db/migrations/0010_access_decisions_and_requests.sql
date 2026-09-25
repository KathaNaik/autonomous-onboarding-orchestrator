CREATE TYPE "public"."access_decision" AS ENUM('ALLOW', 'DENY', 'REQUIRES_APPROVAL');--> statement-breakpoint
CREATE TYPE "public"."access_request_status" AS ENUM('READY_FOR_PROVISIONING', 'DENIED', 'AWAITING_APPROVAL', 'REJECTED');--> statement-breakpoint
CREATE TABLE "access_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_decision_key" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"resource_id" text NOT NULL,
	"catalog_version" text NOT NULL,
	"catalog_hash" text NOT NULL,
	"policy_version" text NOT NULL,
	"policy_hash" text NOT NULL,
	"department_code" text NOT NULL,
	"role_family_code" text NOT NULL,
	"employment_type" text NOT NULL,
	"employee_facts_source_event_id" text NOT NULL,
	"decision" "access_decision" NOT NULL,
	"matched_rule_id" text NOT NULL,
	"reason_code" text NOT NULL,
	"explanation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_decisions_logical_decision_key_unique" UNIQUE("logical_decision_key")
);
--> statement-breakpoint
CREATE TABLE "access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"access_decision_id" uuid NOT NULL,
	"resource_id" text NOT NULL,
	"status" "access_request_status" NOT NULL,
	"authorized_via" text,
	"external_operation_id" uuid,
	"approval_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_requests_access_decision_id_unique" UNIQUE("access_decision_id"),
	CONSTRAINT "access_requests_external_operation_id_unique" UNIQUE("external_operation_id"),
	CONSTRAINT "access_requests_authorized_via_iff_ready" CHECK (("access_requests"."status" = 'READY_FOR_PROVISIONING') = ("access_requests"."authorized_via" IS NOT NULL)),
	CONSTRAINT "access_requests_authorized_via_valid" CHECK ("access_requests"."authorized_via" IS NULL OR "access_requests"."authorized_via" IN ('POLICY', 'APPROVAL')),
	CONSTRAINT "access_requests_approval_path" CHECK ("access_requests"."status" NOT IN ('AWAITING_APPROVAL', 'REJECTED') OR "access_requests"."authorized_via" IS NULL),
	CONSTRAINT "access_requests_approved_has_approval" CHECK ("access_requests"."authorized_via" IS DISTINCT FROM 'APPROVAL' OR "access_requests"."approval_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "access_decisions" ADD CONSTRAINT "access_decisions_workflow_id_onboarding_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."onboarding_workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_decisions" ADD CONSTRAINT "access_decisions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_decisions" ADD CONSTRAINT "access_decisions_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_workflow_id_onboarding_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."onboarding_workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_access_decision_id_access_decisions_id_fk" FOREIGN KEY ("access_decision_id") REFERENCES "public"."access_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_external_operation_id_external_operations_id_fk" FOREIGN KEY ("external_operation_id") REFERENCES "public"."external_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_decisions_run_resource_idx" ON "access_decisions" USING btree ("agent_run_id","resource_id");--> statement-breakpoint
CREATE INDEX "access_decisions_workflow_id_idx" ON "access_decisions" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "access_requests_workflow_id_idx" ON "access_requests" USING btree ("workflow_id");