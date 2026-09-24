ALTER TABLE "project_photo" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "project_photo" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "project_photo" ADD COLUMN "location_accuracy_m" integer;--> statement-breakpoint
ALTER TABLE "task_comment" ADD COLUMN "client_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "task_comment_client_idx" ON "task_comment" USING btree ("author_id","client_id") WHERE "task_comment"."client_id" is not null;