ALTER TABLE "external_identity_claims" DROP CONSTRAINT "external_identity_claims_source_check";--> statement-breakpoint
ALTER TABLE "external_identity_claims" ADD COLUMN "recorded_by" text;--> statement-breakpoint
ALTER TABLE "external_identity_claims" ADD CONSTRAINT "external_identity_claims_source_check" CHECK ("external_identity_claims"."source" IN ('HR_INPUT', 'EMPLOYEE_INPUT'));