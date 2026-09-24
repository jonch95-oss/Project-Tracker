CREATE TABLE "key_date_reminder" (
	"key_date_id" uuid NOT NULL,
	"date" text NOT NULL,
	"threshold" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "key_date_reminder_key_date_id_date_threshold_pk" PRIMARY KEY("key_date_id","date","threshold")
);
--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "next_occurrence_id" uuid;--> statement-breakpoint
ALTER TABLE "key_date_reminder" ADD CONSTRAINT "key_date_reminder_key_date_id_key_date_id_fk" FOREIGN KEY ("key_date_id") REFERENCES "public"."key_date"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_series_idx" ON "task" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "task_approver_idx" ON "task" USING btree ("approver_id","status");--> statement-breakpoint
-- Approvals requested before approvers were recorded go to the owner.
UPDATE "task" SET "approver_id" = (SELECT "id" FROM "user" WHERE "role" = 'owner' AND "status" = 'active' ORDER BY "created_at" LIMIT 1) WHERE "status" = 'awaiting_approval' AND "approver_id" IS NULL;
