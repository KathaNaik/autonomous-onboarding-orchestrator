CREATE TABLE "operator_session_revocations" (
	"session_nonce" uuid PRIMARY KEY NOT NULL,
	"operator_id" text NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "operator_session_revocations_expires_idx" ON "operator_session_revocations" USING btree ("expires_at");