CREATE TABLE "onboarding_plan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_run_key" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"provisioning_plan_id" uuid NOT NULL,
	"source_agent_run_id" uuid NOT NULL,
	"prompt_version" text NOT NULL,
	"model_provider" text NOT NULL,
	"model" text NOT NULL,
	"model_config" text NOT NULL,
	"served_model" text,
	"provider_response_id" text,
	"catalog_version" text NOT NULL,
	"catalog_hash" text NOT NULL,
	"policy_version" text NOT NULL,
	"policy_hash" text NOT NULL,
	"input_hash" text NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"resource_snapshot" jsonb NOT NULL,
	"status" "agent_run_status" NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"model_calls" integer,
	"owner_token" uuid,
	"owner_id" text,
	"owner_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"output" jsonb,
	"error_category" text,
	"error_message" text,
	"error_retryable" boolean,
	"error_detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_plan_runs_logical_run_key_unique" UNIQUE("logical_run_key"),
	CONSTRAINT "onboarding_plan_runs_attempts_positive" CHECK ("onboarding_plan_runs"."attempts" >= 1),
	CONSTRAINT "onboarding_plan_runs_owner_all_or_nothing" CHECK (("onboarding_plan_runs"."owner_token" IS NULL) = ("onboarding_plan_runs"."owner_id" IS NULL) AND ("onboarding_plan_runs"."owner_token" IS NULL) = ("onboarding_plan_runs"."owner_expires_at" IS NULL)),
	CONSTRAINT "onboarding_plan_runs_owner_iff_running" CHECK (("onboarding_plan_runs"."status" = 'RUNNING') = ("onboarding_plan_runs"."owner_token" IS NOT NULL)),
	CONSTRAINT "onboarding_plan_runs_succeeded_complete" CHECK ("onboarding_plan_runs"."status" <> 'SUCCEEDED' OR ("onboarding_plan_runs"."completed_at" IS NOT NULL AND "onboarding_plan_runs"."output" IS NOT NULL AND "onboarding_plan_runs"."error_category" IS NULL)),
	CONSTRAINT "onboarding_plan_runs_failed_has_error" CHECK ("onboarding_plan_runs"."status" <> 'FAILED' OR ("onboarding_plan_runs"."completed_at" IS NOT NULL AND "onboarding_plan_runs"."error_category" IS NOT NULL AND "onboarding_plan_runs"."error_retryable" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "onboarding_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"onboarding_plan_run_id" uuid NOT NULL,
	"provisioning_plan_id" uuid NOT NULL,
	"prompt_version" text NOT NULL,
	"summary" text NOT NULL,
	"tasks" jsonb NOT NULL,
	"task_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_plans_workflow_id_unique" UNIQUE("workflow_id"),
	CONSTRAINT "onboarding_plans_onboarding_plan_run_id_unique" UNIQUE("onboarding_plan_run_id"),
	CONSTRAINT "onboarding_plans_task_count_range" CHECK ("onboarding_plans"."task_count" BETWEEN 3 AND 12 AND jsonb_array_length("onboarding_plans"."tasks") = "onboarding_plans"."task_count")
);
--> statement-breakpoint
ALTER TABLE "onboarding_plan_runs" ADD CONSTRAINT "onboarding_plan_runs_workflow_id_onboarding_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."onboarding_workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_plan_runs" ADD CONSTRAINT "onboarding_plan_runs_provisioning_plan_id_workflow_provisioning_plans_id_fk" FOREIGN KEY ("provisioning_plan_id") REFERENCES "public"."workflow_provisioning_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_plan_runs" ADD CONSTRAINT "onboarding_plan_runs_source_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("source_agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_plans" ADD CONSTRAINT "onboarding_plans_workflow_id_onboarding_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."onboarding_workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_plans" ADD CONSTRAINT "onboarding_plans_onboarding_plan_run_id_onboarding_plan_runs_id_fk" FOREIGN KEY ("onboarding_plan_run_id") REFERENCES "public"."onboarding_plan_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_plans" ADD CONSTRAINT "onboarding_plans_provisioning_plan_id_workflow_provisioning_plans_id_fk" FOREIGN KEY ("provisioning_plan_id") REFERENCES "public"."workflow_provisioning_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_plan_runs_workflow_id_idx" ON "onboarding_plan_runs" USING btree ("workflow_id");--> statement-breakpoint
-- onboarding_plans is append-only (M8): an accepted onboarding plan is never changed or removed.
-- Reject every UPDATE, DELETE and TRUNCATE.
CREATE FUNCTION "onboarding_plans_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'onboarding_plans is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "onboarding_plans_no_update_or_delete"
  BEFORE UPDATE OR DELETE ON "onboarding_plans"
  FOR EACH ROW EXECUTE FUNCTION "onboarding_plans_reject_mutation"();
--> statement-breakpoint
CREATE TRIGGER "onboarding_plans_no_truncate"
  BEFORE TRUNCATE ON "onboarding_plans"
  FOR EACH STATEMENT EXECUTE FUNCTION "onboarding_plans_reject_mutation"();
