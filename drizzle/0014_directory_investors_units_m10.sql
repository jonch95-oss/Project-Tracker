CREATE TABLE "capital_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"notice_on" text NOT NULL,
	"due_on" text NOT NULL,
	"note" text,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_call_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"investor_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"received_cents" bigint DEFAULT 0 NOT NULL,
	"received_on" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_commitment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"investor_id" uuid NOT NULL,
	"committed_cents" bigint NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_terms" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"tiers" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid,
	"name" text NOT NULL,
	"title" text,
	"email" text,
	"phone" text,
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "distribution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"paid_on" text NOT NULL,
	"total_cents" bigint NOT NULL,
	"gp_cents" bigint DEFAULT 0 NOT NULL,
	"note" text,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "distribution_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"distribution_id" uuid NOT NULL,
	"investor_id" uuid NOT NULL,
	"roc_cents" bigint DEFAULT 0 NOT NULL,
	"pref_cents" bigint DEFAULT 0 NOT NULL,
	"profit_cents" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'equity' NOT NULL,
	"contact_name" text,
	"email" text,
	"user_id" text,
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unit_selection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"category" text NOT NULL,
	"choice" text NOT NULL,
	"upgrade_cents" bigint,
	"sign_off_by" text,
	"signed_off_on" text,
	"signed_off_name" text,
	"notes" text,
	"task_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"kind" text DEFAULT 'contractor' NOT NULL,
	"trade" text,
	"phone" text,
	"email" text,
	"website" text,
	"address" text,
	"rating" integer,
	"notes" text,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"category" text NOT NULL,
	"label" text,
	"number" text,
	"expires_on" text,
	"object_key" text,
	"original_name" text,
	"content_type" text,
	"size_bytes" bigint,
	"reminded_mark" text,
	"reminded_for" text,
	"uploaded_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_upload" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "lot_front_ft" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "lot_depth_ft" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "sale_unit" ADD COLUMN "exposure" text;--> statement-breakpoint
ALTER TABLE "sale_unit" ADD COLUMN "outdoor_sf" integer;--> statement-breakpoint
ALTER TABLE "sale_unit" ADD COLUMN "outdoor_type" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "vendor_id" uuid;--> statement-breakpoint
ALTER TABLE "capital_call" ADD CONSTRAINT "capital_call_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_call" ADD CONSTRAINT "capital_call_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_call_item" ADD CONSTRAINT "capital_call_item_call_id_capital_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."capital_call"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_call_item" ADD CONSTRAINT "capital_call_item_investor_id_investor_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."investor"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_commitment" ADD CONSTRAINT "capital_commitment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_commitment" ADD CONSTRAINT "capital_commitment_investor_id_investor_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."investor"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_terms" ADD CONSTRAINT "capital_terms_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_vendor_id_vendor_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendor"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution" ADD CONSTRAINT "distribution_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution" ADD CONSTRAINT "distribution_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_item" ADD CONSTRAINT "distribution_item_distribution_id_distribution_id_fk" FOREIGN KEY ("distribution_id") REFERENCES "public"."distribution"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_item" ADD CONSTRAINT "distribution_item_investor_id_investor_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."investor"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investor" ADD CONSTRAINT "investor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_selection" ADD CONSTRAINT "unit_selection_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_selection" ADD CONSTRAINT "unit_selection_unit_id_sale_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."sale_unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_selection" ADD CONSTRAINT "unit_selection_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_selection" ADD CONSTRAINT "unit_selection_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor" ADD CONSTRAINT "vendor_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_document" ADD CONSTRAINT "vendor_document_vendor_id_vendor_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_document" ADD CONSTRAINT "vendor_document_uploaded_by_id_user_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capital_call_number_idx" ON "capital_call" USING btree ("project_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "capital_call_item_idx" ON "capital_call_item" USING btree ("call_id","investor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capital_commitment_idx" ON "capital_commitment" USING btree ("project_id","investor_id");--> statement-breakpoint
CREATE INDEX "contact_vendor_idx" ON "contact" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "contact_email_idx" ON "contact" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_number_idx" ON "distribution" USING btree ("project_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_item_idx" ON "distribution_item" USING btree ("distribution_id","investor_id");--> statement-breakpoint
CREATE INDEX "investor_user_idx" ON "investor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "unit_selection_unit_idx" ON "unit_selection" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "unit_selection_project_idx" ON "unit_selection" USING btree ("project_id","sign_off_by");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_key_idx" ON "vendor" USING btree ("key");--> statement-breakpoint
CREATE INDEX "vendor_document_vendor_idx" ON "vendor_document" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "vendor_document_expiry_idx" ON "vendor_document" USING btree ("expires_on");--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_vendor_id_vendor_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendor"("id") ON DELETE set null ON UPDATE no action;