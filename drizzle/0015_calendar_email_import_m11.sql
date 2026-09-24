CREATE TABLE "calendar_feed" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_email" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"project_id" uuid,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"subject" text,
	"status" text NOT NULL,
	"reason" text,
	"sender_id" text,
	"attachments" integer DEFAULT 0 NOT NULL,
	"quota_day" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "inbound_key" text;--> statement-breakpoint
ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_email" ADD CONSTRAINT "inbound_email_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_email" ADD CONSTRAINT "inbound_email_sender_id_user_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_feed_token_idx" ON "calendar_feed" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "calendar_feed_user_idx" ON "calendar_feed" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_email_provider_idx" ON "inbound_email" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "inbound_email_day_idx" ON "inbound_email" USING btree ("quota_day");--> statement-breakpoint
CREATE INDEX "inbound_email_project_idx" ON "inbound_email" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_inbound_key_unique" UNIQUE("inbound_key");