-- audit_events is append-only: reject every UPDATE, DELETE and TRUNCATE.
CREATE FUNCTION "audit_events_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_events_no_update_or_delete"
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_events_reject_mutation"();
--> statement-breakpoint
CREATE TRIGGER "audit_events_no_truncate"
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_reject_mutation"();
