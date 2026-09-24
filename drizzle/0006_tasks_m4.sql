CREATE TABLE "key_date" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"date" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"project_id" uuid,
	"task_id" uuid,
	"actor_id" text,
	"title" text NOT NULL,
	"body" text,
	"href" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_comment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"author_id" text,
	"body" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_watcher" (
	"task_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_watcher_task_id_user_id_pk" PRIMARY KEY("task_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "approval_decision" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "approval_note" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "approval_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "approval_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "approval_decided_by_id" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "waiting_since" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "follow_up_on" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "key_date" ADD CONSTRAINT "key_date_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_date" ADD CONSTRAINT "key_date_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comment" ADD CONSTRAINT "task_comment_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comment" ADD CONSTRAINT "task_comment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comment" ADD CONSTRAINT "task_comment_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_watcher" ADD CONSTRAINT "task_watcher_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_watcher" ADD CONSTRAINT "task_watcher_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "key_date_project_idx" ON "key_date" USING btree ("project_id","date");--> statement-breakpoint
CREATE INDEX "key_date_date_idx" ON "key_date" USING btree ("date");--> statement-breakpoint
CREATE INDEX "notification_user_idx" ON "notification" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "task_comment_task_idx" ON "task_comment" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_watcher_user_idx" ON "task_watcher" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_approval_decided_by_id_user_id_fk" FOREIGN KEY ("approval_decided_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;