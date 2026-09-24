CREATE TABLE "file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"name" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_id" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"object_key" text NOT NULL,
	"thumb_key" text,
	"original_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"thumb_bytes" bigint DEFAULT 0 NOT NULL,
	"scan_status" text DEFAULT 'not_scanned' NOT NULL,
	"note" text,
	"uploaded_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"gated" boolean DEFAULT false NOT NULL,
	"is_photos" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folder_share" (
	"folder_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folder_share_folder_id_user_id_pk" PRIMARY KEY("folder_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "task_attachment" (
	"task_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"added_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_attachment_task_id_file_id_pk" PRIMARY KEY("task_id","file_id")
);
--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_folder_id_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folder"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_deleted_by_id_user_id_fk" FOREIGN KEY ("deleted_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_uploaded_by_id_user_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_share" ADD CONSTRAINT "folder_share_folder_id_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_share" ADD CONSTRAINT "folder_share_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attachment" ADD CONSTRAINT "task_attachment_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attachment" ADD CONSTRAINT "task_attachment_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attachment" ADD CONSTRAINT "task_attachment_added_by_id_user_id_fk" FOREIGN KEY ("added_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_folder_idx" ON "file" USING btree ("folder_id","deleted_at");--> statement-breakpoint
CREATE INDEX "file_project_idx" ON "file" USING btree ("project_id","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "file_version_number_idx" ON "file_version" USING btree ("file_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "file_version_object_idx" ON "file_version" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "folder_project_idx" ON "folder" USING btree ("project_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "folder_project_name_idx" ON "folder" USING btree ("project_id",lower("name"));--> statement-breakpoint
CREATE INDEX "folder_share_user_idx" ON "folder_share" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_attachment_file_idx" ON "task_attachment" USING btree ("file_id");--> statement-breakpoint
-- Existing projects get the default folders (brief §14).
INSERT INTO "folder" ("project_id", "name", "gated", "is_photos", "sort_order")
SELECT p."id", f.name, f.name = 'Financial', f.name = 'Photos', f.ord - 1
FROM "project" p
CROSS JOIN unnest(ARRAY['Acquisition','Legal','Title & Survey','Environmental','Design','DOB & Permits','Construction','Photos','Financial','Sales','Closeout']) WITH ORDINALITY AS f(name, ord)
ON CONFLICT DO NOTHING;
