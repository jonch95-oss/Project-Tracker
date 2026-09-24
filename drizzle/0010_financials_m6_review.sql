CREATE TABLE "project_sequence" (
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"last" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "project_sequence_project_id_kind_pk" PRIMARY KEY("project_id","kind")
);
--> statement-breakpoint
ALTER TABLE "project_headline" ADD COLUMN "use_budget_detail" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_headline" ADD COLUMN "use_sales_detail" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_headline" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_sequence" ADD CONSTRAINT "project_sequence_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;