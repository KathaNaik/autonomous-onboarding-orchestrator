CREATE TABLE "external_identity_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"provider" "external_provider" NOT NULL,
	"claimed_login" text NOT NULL,
	"source" text NOT NULL,
	"source_event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "provider_state" text;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "provider_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "external_identity_claims" ADD CONSTRAINT "external_identity_claims_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_identity_claims_employee_provider_idx" ON "external_identity_claims" USING btree ("employee_id","provider");