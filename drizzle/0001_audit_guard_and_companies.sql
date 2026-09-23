-- Audit log is append-only: reject UPDATE, DELETE and TRUNCATE for every role.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();
--> statement-breakpoint
INSERT INTO "company" ("name", "short_name", "sort_order") VALUES
  ('Ariel Development Group', 'Ariel', 1),
  ('Lian Development JV Group', 'Lian JV', 2)
ON CONFLICT ("name") DO NOTHING;
