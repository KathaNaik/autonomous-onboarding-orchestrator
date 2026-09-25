-- access_decisions is append-only (M6B): a recorded authorization decision is never changed or
-- removed, so a later policy or catalog release cannot alter what was decided. Reject every
-- UPDATE, DELETE and TRUNCATE.
CREATE FUNCTION "access_decisions_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'access_decisions is append-only (% rejected)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "access_decisions_no_update_or_delete"
  BEFORE UPDATE OR DELETE ON "access_decisions"
  FOR EACH ROW EXECUTE FUNCTION "access_decisions_reject_mutation"();
--> statement-breakpoint
CREATE TRIGGER "access_decisions_no_truncate"
  BEFORE TRUNCATE ON "access_decisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "access_decisions_reject_mutation"();
