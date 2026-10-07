CREATE TABLE "operator_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"failed_sign_ins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_sign_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "operator_accounts_email_unique" UNIQUE("email"),
	CONSTRAINT "operator_accounts_email_check" CHECK ("operator_accounts"."email" = lower("operator_accounts"."email") AND char_length("operator_accounts"."email") BETWEEN 3 AND 64),
	CONSTRAINT "operator_accounts_hash_check" CHECK ("operator_accounts"."password_hash" LIKE 'scrypt$%'),
	CONSTRAINT "operator_accounts_failed_check" CHECK ("operator_accounts"."failed_sign_ins" >= 0)
);
--> statement-breakpoint
CREATE INDEX "operator_accounts_created_idx" ON "operator_accounts" USING btree ("created_at");