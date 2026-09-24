CREATE TABLE "drawing_set" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"discipline" text NOT NULL,
	"name" text NOT NULL,
	"issued_on" text,
	"current" boolean DEFAULT true NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawing_sheet" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"set_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" text NOT NULL,
	"title" text,
	"file_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"type" text NOT NULL,
	"number" integer NOT NULL,
	"title" text,
	"held_on" text NOT NULL,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agenda" text,
	"notes" text,
	"created_by_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"kind" text DEFAULT 'action' NOT NULL,
	"text" text NOT NULL,
	"assignee_id" text,
	"due_on" text,
	"task_id" uuid,
	"carried_from_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "punch_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"sheet_id" uuid,
	"page" integer DEFAULT 1 NOT NULL,
	"x" double precision,
	"y" double precision,
	"title" text NOT NULL,
	"description" text,
	"trade" text,
	"vendor_name" text,
	"assignee_id" text,
	"floor" text,
	"unit" text,
	"due_on" text,
	"status" text DEFAULT 'open' NOT NULL,
	"photo_id" uuid,
	"created_by_id" text,
	"closed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfi" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"subject" text NOT NULL,
	"question" text NOT NULL,
	"from_name" text,
	"from_user_id" text,
	"to_name" text,
	"to_user_id" text,
	"due_on" text,
	"answer" text,
	"answered_at" timestamp with time zone,
	"answered_by_id" text,
	"cost_impact_cents" bigint,
	"schedule_impact_days" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"change_order_id" uuid,
	"created_by_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfi_attachment" (
	"rfi_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rfi_attachment_rfi_id_file_id_pk" PRIMARY KEY("rfi_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "schedule_baseline" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"finish_on" text,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text,
	"status" text DEFAULT 'current' NOT NULL,
	"requested_by_id" text,
	"approved_by_id" text,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"date" text NOT NULL,
	"weather" jsonb,
	"manpower" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"work_performed" text,
	"deliveries" text,
	"inspections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visitors" text,
	"safety" text,
	"delays" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_by_id" text,
	"updated_by_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submittal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"spec_section" text,
	"item" text NOT NULL,
	"submitted_by" text,
	"reviewer_name" text,
	"reviewer_id" text,
	"due_on" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submittal_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submittal_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"file_id" uuid,
	"submitted_on" text,
	"decision" text,
	"decided_on" text,
	"decided_by_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_photo" ADD COLUMN "site_log_id" uuid;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "start_on" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "started_on" text;--> statement-breakpoint
ALTER TABLE "drawing_set" ADD CONSTRAINT "drawing_set_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_set" ADD CONSTRAINT "drawing_set_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_sheet" ADD CONSTRAINT "drawing_sheet_set_id_drawing_set_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."drawing_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_sheet" ADD CONSTRAINT "drawing_sheet_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_sheet" ADD CONSTRAINT "drawing_sheet_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_sheet" ADD CONSTRAINT "drawing_sheet_version_id_file_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting" ADD CONSTRAINT "meeting_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_item" ADD CONSTRAINT "meeting_item_meeting_id_meeting_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meeting"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_item" ADD CONSTRAINT "meeting_item_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_item" ADD CONSTRAINT "meeting_item_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punch_item" ADD CONSTRAINT "punch_item_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punch_item" ADD CONSTRAINT "punch_item_sheet_id_drawing_sheet_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."drawing_sheet"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punch_item" ADD CONSTRAINT "punch_item_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punch_item" ADD CONSTRAINT "punch_item_photo_id_project_photo_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."project_photo"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punch_item" ADD CONSTRAINT "punch_item_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfi" ADD CONSTRAINT "rfi_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfi" ADD CONSTRAINT "rfi_from_user_id_user_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfi" ADD CONSTRAINT "rfi_to_user_id_user_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfi" ADD CONSTRAINT "rfi_answered_by_id_user_id_fk" FOREIGN KEY ("answered_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfi" ADD CONSTRAINT "rfi_change_order_id_change_order_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."change_order"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfi" ADD CONSTRAINT "rfi_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfi_attachment" ADD CONSTRAINT "rfi_attachment_rfi_id_rfi_id_fk" FOREIGN KEY ("rfi_id") REFERENCES "public"."rfi"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfi_attachment" ADD CONSTRAINT "rfi_attachment_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_baseline" ADD CONSTRAINT "schedule_baseline_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_baseline" ADD CONSTRAINT "schedule_baseline_requested_by_id_user_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_baseline" ADD CONSTRAINT "schedule_baseline_approved_by_id_user_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_log" ADD CONSTRAINT "site_log_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_log" ADD CONSTRAINT "site_log_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_log" ADD CONSTRAINT "site_log_updated_by_id_user_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submittal" ADD CONSTRAINT "submittal_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submittal" ADD CONSTRAINT "submittal_reviewer_id_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submittal" ADD CONSTRAINT "submittal_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submittal_revision" ADD CONSTRAINT "submittal_revision_submittal_id_submittal_id_fk" FOREIGN KEY ("submittal_id") REFERENCES "public"."submittal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submittal_revision" ADD CONSTRAINT "submittal_revision_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submittal_revision" ADD CONSTRAINT "submittal_revision_decided_by_id_user_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drawing_set_idx" ON "drawing_set" USING btree ("project_id","discipline","current");--> statement-breakpoint
CREATE INDEX "drawing_sheet_set_idx" ON "drawing_sheet" USING btree ("set_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_number_idx" ON "meeting" USING btree ("project_id","type","number");--> statement-breakpoint
CREATE INDEX "meeting_item_meeting_idx" ON "meeting_item" USING btree ("meeting_id","sort_order");--> statement-breakpoint
CREATE INDEX "meeting_item_task_idx" ON "meeting_item" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "punch_number_idx" ON "punch_item" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "punch_filter_idx" ON "punch_item" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "punch_sheet_idx" ON "punch_item" USING btree ("sheet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rfi_number_idx" ON "rfi" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "rfi_status_idx" ON "rfi" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_baseline_number_idx" ON "schedule_baseline" USING btree ("project_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_baseline_current_idx" ON "schedule_baseline" USING btree ("project_id") WHERE "schedule_baseline"."status" = 'current';--> statement-breakpoint
CREATE UNIQUE INDEX "site_log_day_idx" ON "site_log" USING btree ("project_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "submittal_number_idx" ON "submittal" USING btree ("project_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "submittal_revision_idx" ON "submittal_revision" USING btree ("submittal_id","revision");--> statement-breakpoint
ALTER TABLE "project_photo" ADD CONSTRAINT "project_photo_site_log_id_site_log_id_fk" FOREIGN KEY ("site_log_id") REFERENCES "public"."site_log"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_photo_site_log_idx" ON "project_photo" USING btree ("site_log_id");