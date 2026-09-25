CREATE TABLE "weekly_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_of" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_report_week_idx" ON "weekly_report" USING btree ("week_of");