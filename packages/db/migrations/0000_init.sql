CREATE TYPE "public"."workflow_state" AS ENUM('RECEIVED', 'ACCESS_PLANNING', 'POLICY_REVIEW', 'AWAITING_APPROVAL', 'PROVISIONING', 'ONBOARDING_GENERATION', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."workflow_step_status" AS ENUM('RUNNING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid,
	"event_type" text NOT NULL,
	"actor" text NOT NULL,
	"from_state" "workflow_state",
	"to_state" "workflow_state",
	"workflow_version" integer,
	"correlation_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hris_employee_id" text NOT NULL,
	"email" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employees_hris_employee_id_unique" UNIQUE("hris_employee_id")
);
--> statement-breakpoint
CREATE TABLE "onboarding_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"state" "workflow_state" DEFAULT 'RECEIVED' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"failure_reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_workflows_version_positive" CHECK ("onboarding_workflows"."version" >= 1),
	CONSTRAINT "onboarding_workflows_failure_reason_iff_failed" CHECK (("onboarding_workflows"."state" = 'FAILED') = ("onboarding_workflows"."failure_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "workflow_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"subject_key" text,
	"status" "workflow_step_status" NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_steps_attempt_positive" CHECK ("workflow_steps"."attempt" >= 1)
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workflow_id_onboarding_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."onboarding_workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_workflows" ADD CONSTRAINT "onboarding_workflows_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workflow_id_onboarding_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."onboarding_workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_workflow_id_idx" ON "audit_events" USING btree ("workflow_id","workflow_version");--> statement-breakpoint
CREATE INDEX "onboarding_workflows_employee_id_idx" ON "onboarding_workflows" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "onboarding_workflows_state_idx" ON "onboarding_workflows" USING btree ("state");--> statement-breakpoint
CREATE INDEX "workflow_steps_workflow_id_idx" ON "workflow_steps" USING btree ("workflow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_steps_one_running_idx" ON "workflow_steps" USING btree ("workflow_id","step_key",coalesce("subject_key", '')) WHERE "workflow_steps"."status" = 'RUNNING';