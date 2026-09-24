ALTER TABLE "employees" ADD COLUMN "department_code" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "role_family_code" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "employment_type" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "facts_hris_event_id" text;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_canonical_facts_all_or_none" CHECK (("employees"."department_code" IS NULL AND "employees"."role_family_code" IS NULL AND "employees"."employment_type" IS NULL AND "employees"."facts_hris_event_id" IS NULL) OR ("employees"."department_code" IS NOT NULL AND "employees"."role_family_code" IS NOT NULL AND "employees"."employment_type" IS NOT NULL AND "employees"."facts_hris_event_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_code_valid" CHECK ("employees"."department_code" IN ('ENGINEERING', 'PRODUCT', 'SALES'));--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_role_family_code_valid" CHECK ("employees"."role_family_code" IN ('SOFTWARE_ENGINEER', 'SRE', 'ENGINEERING_MANAGER', 'PRODUCT_MANAGER', 'ACCOUNT_EXECUTIVE'));--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_employment_type_valid" CHECK ("employees"."employment_type" IN ('FULL_TIME', 'CONTRACTOR'));