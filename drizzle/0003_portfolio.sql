CREATE TABLE "pending_upload" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"objects" jsonb NOT NULL,
	"meta" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_headline" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"purchase_price_cents" bigint,
	"total_budget_cents" bigint,
	"projected_sellout_cents" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_phase" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_on" text,
	"completed_on" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_photo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"thumb_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"thumb_bytes" bigint NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"caption" text,
	"taken_at" timestamp with time zone,
	"uploaded_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "lot_area_sqft" integer;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "zoning" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "resid_far" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "built_far" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "unused_zsf" integer;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "units" integer;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "gross_sf" integer;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "sellable_sf" integer;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "hero_photo_id" uuid;--> statement-breakpoint
ALTER TABLE "pending_upload" ADD CONSTRAINT "pending_upload_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_upload" ADD CONSTRAINT "pending_upload_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_headline" ADD CONSTRAINT "project_headline_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_phase" ADD CONSTRAINT "project_phase_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_photo" ADD CONSTRAINT "project_photo_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_photo" ADD CONSTRAINT "project_photo_uploaded_by_id_user_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_upload_user_idx" ON "pending_upload" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pending_upload_expires_idx" ON "pending_upload" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_phase_key_idx" ON "project_phase" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "project_phase_project_idx" ON "project_phase" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_photo_project_idx" ON "project_photo" USING btree ("project_id","created_at");--> statement-breakpoint
-- Backfill: projects created before phases existed get their type's default phases, first phase current.
INSERT INTO "project_phase" ("project_id", "key", "name", "sort_order", "status", "started_on")
SELECT p.id, d.key, d.name, d.ord, CASE WHEN d.ord = 0 THEN 'active' ELSE 'pending' END,
       CASE WHEN d.ord = 0 THEN to_char(p.created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') END
FROM "project" p
JOIN (VALUES
  ('std','pipeline','Pipeline',0),('std','under_contract','Under Contract',1),('std','due_diligence','Due Diligence',2),
  ('std','closing','Closing',3),('std','design_zoning','Design & Zoning',4),('std','dob_filing','DOB Filing & Approval',5),
  ('std','pre_construction','Pre-Construction',6),('std','construction','Construction',7),('std','tco_co','TCO / CO',8),
  ('std','ag_plan_sales','AG Plan & Sales',9),('std','closed','Sold Out / Closed',10),
  ('flip','pipeline','Pipeline',0),('flip','under_contract','Under Contract',1),('flip','marketing','Marketing to End Buyers',2),
  ('flip','assignment','Assignment',3),('flip','closed','Closed',4),
  ('auction','pipeline','Pipeline',0),('auction','auction','Auction',1),('auction','closing','Closing',2),
  ('auction','design_zoning','Design & Zoning',3),('auction','dob_filing','DOB Filing & Approval',4),
  ('auction','pre_construction','Pre-Construction',5),('auction','construction','Construction',6),('auction','tco_co','TCO / CO',7),
  ('auction','ag_plan_sales','AG Plan & Sales',8),('auction','closed','Sold Out / Closed',9)
) AS d(kind, key, name, ord)
  ON d.kind = CASE p.type WHEN 'contract_flip' THEN 'flip' WHEN 'foreclosure_auction' THEN 'auction' ELSE 'std' END
WHERE NOT EXISTS (SELECT 1 FROM "project_phase" x WHERE x.project_id = p.id);
