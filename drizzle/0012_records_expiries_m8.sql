CREATE TABLE "expiry_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"category" text NOT NULL,
	"label" text,
	"vendor_name" text,
	"vendor_key" text,
	"expires_on" text NOT NULL,
	"notes" text,
	"record_ref" text,
	"closed_at" timestamp with time zone,
	"created_by_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expiry_reminder" (
	"item_id" uuid NOT NULL,
	"expires_on" text NOT NULL,
	"mark" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expiry_reminder_item_id_expires_on_mark_pk" PRIMARY KEY("item_id","expires_on","mark")
);
--> statement-breakpoint
CREATE TABLE "record_alert" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"item_key" text NOT NULL,
	"kind" text NOT NULL,
	"critical" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"task_id" uuid,
	"dismissed_at" timestamp with time zone,
	"dismissed_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"status" text,
	"date" text,
	"open" boolean DEFAULT false NOT NULL,
	"critical" boolean DEFAULT false NOT NULL,
	"url" text NOT NULL,
	"hearing_on" text,
	"expires_on" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_sync" (
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"data_as_of" timestamp with time zone,
	"rows" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"error" text,
	CONSTRAINT "record_sync_project_id_source_pk" PRIMARY KEY("project_id","source")
);
--> statement-breakpoint
CREATE TABLE "violation_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"item_key" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"url" text NOT NULL,
	"issued_on" text,
	"stage" text DEFAULT 'issued' NOT NULL,
	"hearing_on" text,
	"key_date_id" uuid,
	"notes" text,
	"closed_on" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "critical" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "expiry_item" ADD CONSTRAINT "expiry_item_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expiry_item" ADD CONSTRAINT "expiry_item_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expiry_reminder" ADD CONSTRAINT "expiry_reminder_item_id_expiry_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."expiry_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_alert" ADD CONSTRAINT "record_alert_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_alert" ADD CONSTRAINT "record_alert_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_alert" ADD CONSTRAINT "record_alert_dismissed_by_id_user_id_fk" FOREIGN KEY ("dismissed_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_item" ADD CONSTRAINT "record_item_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_sync" ADD CONSTRAINT "record_sync_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violation_case" ADD CONSTRAINT "violation_case_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "violation_case" ADD CONSTRAINT "violation_case_key_date_id_key_date_id_fk" FOREIGN KEY ("key_date_id") REFERENCES "public"."key_date"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expiry_item_project_idx" ON "expiry_item" USING btree ("project_id","expires_on");--> statement-breakpoint
CREATE INDEX "expiry_item_vendor_idx" ON "expiry_item" USING btree ("vendor_key");--> statement-breakpoint
CREATE UNIQUE INDEX "expiry_item_record_idx" ON "expiry_item" USING btree ("project_id","record_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "record_alert_dedupe_idx" ON "record_alert" USING btree ("project_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "record_alert_project_idx" ON "record_alert" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "record_item_key_idx" ON "record_item" USING btree ("project_id","source","key");--> statement-breakpoint
CREATE INDEX "record_item_kind_idx" ON "record_item" USING btree ("project_id","kind","open");--> statement-breakpoint
CREATE UNIQUE INDEX "violation_case_item_idx" ON "violation_case" USING btree ("project_id","source","item_key");--> statement-breakpoint
CREATE INDEX "violation_case_stage_idx" ON "violation_case" USING btree ("project_id","stage");