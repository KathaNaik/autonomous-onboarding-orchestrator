CREATE TYPE "public"."agent_run_status" AS ENUM('RUNNING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TABLE "agent_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"resource_id" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason" text NOT NULL,
	"confidence" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_recommendations_confidence_range" CHECK ("agent_recommendations"."confidence" >= 0 AND "agent_recommendations"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_run_key" text NOT NULL,
	"agent" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"prompt_version" text NOT NULL,
	"model_provider" text NOT NULL,
	"model" text NOT NULL,
	"model_config" text NOT NULL,
	"catalog_version" text NOT NULL,
	"catalog_hash" text NOT NULL,
	"input_hash" text NOT NULL,
	"department_code" text NOT NULL,
	"role_family_code" text NOT NULL,
	"employment_type" text NOT NULL,
	"facts_hris_event_id" text NOT NULL,
	"status" "agent_run_status" NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"model_calls" integer,
	"owner_token" uuid,
	"owner_id" text,
	"owner_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"latency_ms" integer,
	"recommendation_count" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"error_category" text,
	"error_message" text,
	"error_retryable" boolean,
	"error_detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_logical_run_key_unique" UNIQUE("logical_run_key"),
	CONSTRAINT "agent_runs_attempts_positive" CHECK ("agent_runs"."attempts" >= 1),
	CONSTRAINT "agent_runs_owner_all_or_nothing" CHECK (("agent_runs"."owner_token" IS NULL) = ("agent_runs"."owner_id" IS NULL) AND ("agent_runs"."owner_token" IS NULL) = ("agent_runs"."owner_expires_at" IS NULL)),
	CONSTRAINT "agent_runs_owner_iff_running" CHECK (("agent_runs"."status" = 'RUNNING') = ("agent_runs"."owner_token" IS NOT NULL)),
	CONSTRAINT "agent_runs_succeeded_complete" CHECK ("agent_runs"."status" <> 'SUCCEEDED' OR ("agent_runs"."completed_at" IS NOT NULL AND "agent_runs"."recommendation_count" IS NOT NULL AND "agent_runs"."error_category" IS NULL)),
	CONSTRAINT "agent_runs_failed_has_error" CHECK ("agent_runs"."status" <> 'FAILED' OR ("agent_runs"."completed_at" IS NOT NULL AND "agent_runs"."error_category" IS NOT NULL AND "agent_runs"."error_retryable" IS NOT NULL)),
	CONSTRAINT "agent_runs_department_code_valid" CHECK ("agent_runs"."department_code" IN ('ENGINEERING', 'PRODUCT', 'SALES')),
	CONSTRAINT "agent_runs_role_family_code_valid" CHECK ("agent_runs"."role_family_code" IN ('SOFTWARE_ENGINEER', 'SRE', 'ENGINEERING_MANAGER', 'PRODUCT_MANAGER', 'ACCOUNT_EXECUTIVE')),
	CONSTRAINT "agent_runs_employment_type_valid" CHECK ("agent_runs"."employment_type" IN ('FULL_TIME', 'CONTRACTOR'))
);
--> statement-breakpoint
ALTER TABLE "agent_recommendations" ADD CONSTRAINT "agent_recommendations_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workflow_id_onboarding_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."onboarding_workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_recommendations_run_resource_idx" ON "agent_recommendations" USING btree ("agent_run_id","resource_id");--> statement-breakpoint
CREATE INDEX "agent_runs_workflow_id_idx" ON "agent_runs" USING btree ("workflow_id");