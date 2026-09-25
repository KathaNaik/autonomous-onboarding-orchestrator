ALTER TYPE "public"."access_request_status" ADD VALUE 'PROVISIONING';--> statement-breakpoint
ALTER TYPE "public"."access_request_status" ADD VALUE 'PROVISIONED';--> statement-breakpoint
ALTER TYPE "public"."access_request_status" ADD VALUE 'PROVISIONING_FAILED';--> statement-breakpoint
CREATE TABLE "external_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"provider" "external_provider" NOT NULL,
	"provider_subject_id" text NOT NULL,
	"provider_login" text NOT NULL,
	"linked_by_operation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_requests" DROP CONSTRAINT "access_requests_authorized_via_iff_ready";--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "provisioning_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "provider_subject_id" text;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "provider_target_id" text;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "provisioned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "provisioning_error_code" text;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_linked_by_operation_id_external_operations_id_fk" FOREIGN KEY ("linked_by_operation_id") REFERENCES "public"."external_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_employee_provider_idx" ON "external_identities" USING btree ("employee_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_provider_subject_idx" ON "external_identities" USING btree ("provider","provider_subject_id");--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_provisioning_operation_id_external_operations_id_fk" FOREIGN KEY ("provisioning_operation_id") REFERENCES "public"."external_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_provisioning_operation_id_unique" UNIQUE("provisioning_operation_id");--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_authorized_via_iff_authorized" CHECK (("access_requests"."status"::text IN ('READY_FOR_PROVISIONING', 'PROVISIONING', 'PROVISIONED', 'PROVISIONING_FAILED')) = ("access_requests"."authorized_via" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_provisioned_has_evidence" CHECK ("access_requests"."status"::text <> 'PROVISIONED' OR ("access_requests"."provisioned_at" IS NOT NULL AND "access_requests"."provisioning_operation_id" IS NOT NULL AND "access_requests"."provider_subject_id" IS NOT NULL AND "access_requests"."provider_target_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_failed_has_code" CHECK (("access_requests"."status"::text = 'PROVISIONING_FAILED') = ("access_requests"."provisioning_error_code" IS NOT NULL));