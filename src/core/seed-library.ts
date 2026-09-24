/**
 * The starter checklist library (brief §5.4), written as seed data. Every
 * task has a default role, a relative due date and, where it matters,
 * dependencies. Toggle tags from the brief become showIf / hideIf conditions;
 * (A) becomes requiresApproval. One default template per project type is
 * assembled from this library; templates are then fully editable in the
 * Template studio.
 */
import type { ProjectTypeKey } from "./labels";
import type { DueRule, TemplateDef, TemplatePhaseDef, TemplateTaskDef } from "./templates";

type Opts = Partial<Omit<TemplateTaskDef, "key" | "phaseKey" | "title" | "role" | "due">> & {
  /** Relative to another task instead of the phase start. */
  after?: string;
  unit?: "business" | "calendar";
  /** Only these project types get the task. */
  types?: readonly ProjectTypeKey[];
};

type LibTask = TemplateTaskDef & { types?: readonly ProjectTypeKey[] };

const A = (approverRole = "Owner") => ({ requiresApproval: true, approverRole });

function t(phaseKey: string, key: string, title: string, role: string, days: number, o: Opts = {}): LibTask {
  const { after, unit, types, ...rest } = o;
  const due: DueRule = { days, unit: unit ?? "business", from: after ? { task: after } : "phase_start" };
  return { key, phaseKey, title, role, due, ...rest, ...(types ? { types } : {}) };
}

const EXISTING_BUILDING: ProjectTypeKey[] = ["gut_renovation", "condo_conversion", "foreclosure_auction"];
const BUILD_TYPES: ProjectTypeKey[] = ["ground_up_condo", "gut_renovation", "condo_conversion", "foreclosure_auction"];

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

export const LIBRARY_PHASES: Record<string, TemplatePhaseDef> = {
  pipeline: { key: "pipeline", name: "Pipeline" },
  under_contract: { key: "under_contract", name: "Under Contract" },
  auction: { key: "auction", name: "Auction" },
  due_diligence: { key: "due_diligence", name: "Due Diligence" },
  closing: { key: "closing", name: "Closing" },
  marketing: { key: "marketing", name: "Marketing to End Buyers" },
  assignment: { key: "assignment", name: "Assignment" },
  design_zoning: { key: "design_zoning", name: "Design & Zoning" },
  dob_filing: { key: "dob_filing", name: "DOB Filing & Approval" },
  pre_construction: { key: "pre_construction", name: "Pre-Construction" },
  construction: { key: "construction", name: "Construction" },
  tco_co: { key: "tco_co", name: "TCO / CO" },
  ag_plan_sales: { key: "ag_plan_sales", name: "AG Plan & Sales", hideIf: ["rental_hold"] },
  rental_hold: { key: "rental_hold", name: "Rental / Hold", showIf: ["rental_hold"] },
  closed: { key: "closed", name: "Sold Out / Closed" },
};

const PHASE_ORDER: Record<ProjectTypeKey, string[]> = {
  ground_up_condo: ["pipeline", "under_contract", "due_diligence", "closing", "design_zoning", "dob_filing", "pre_construction", "construction", "tco_co", "ag_plan_sales", "rental_hold", "closed"],
  gut_renovation: ["pipeline", "under_contract", "due_diligence", "closing", "design_zoning", "dob_filing", "pre_construction", "construction", "tco_co", "ag_plan_sales", "rental_hold", "closed"],
  condo_conversion: ["pipeline", "under_contract", "due_diligence", "closing", "design_zoning", "dob_filing", "pre_construction", "construction", "tco_co", "ag_plan_sales", "rental_hold", "closed"],
  foreclosure_auction: ["pipeline", "auction", "closing", "design_zoning", "dob_filing", "pre_construction", "construction", "tco_co", "ag_plan_sales", "rental_hold", "closed"],
  contract_flip: ["pipeline", "under_contract", "marketing", "assignment", "closed"],
};

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

export const LIBRARY_TASKS: LibTask[] = [
  // Pipeline / Screening
  t("pipeline", "mih_check", "MIH check", "Acquisitions", 2, { killScreen: true, description: "Is the lot in a Mandatory Inclusionary Housing area? Check ZoLa and the MIH map." }),
  t("pipeline", "e_designation_check", "E-designation check", "Acquisitions", 2, { killScreen: true, description: "Check for hazardous materials, noise or air quality E-designations (ZoLa / OER)." }),
  t("pipeline", "lpc_check", "LPC landmark / historic district check", "Acquisitions", 2, { killScreen: true }),
  t("pipeline", "pluto_pull", "PLUTO pull: zoning, lot dimensions, residential FAR, built FAR, unused ZSF", "Acquisitions", 2, { description: "Use residfar for FAR; never assume FAR from the district." }),
  t("pipeline", "acris_chain", "ACRIS chain of title and open mortgages", "Acquisitions", 4, { description: "Two-step lookup: Legals → Master and Parties. The Open Data extract lags live ACRIS by one to two months." }),
  t("pipeline", "open_violations", "DOB / ECB / HPD open violations", "Acquisitions", 4),
  t("pipeline", "occupancy_check", "Occupancy and rent-stabilization check", "Acquisitions", 4, { types: EXISTING_BUILDING }),
  t("pipeline", "sales_comps", "Finished-product sales comps", "Acquisitions", 5, { types: ["ground_up_condo", "gut_renovation", "condo_conversion", "foreclosure_auction", "contract_flip"] }),
  t("pipeline", "pro_forma", "Pro forma / residual land value", "Acquisitions", 7, { dependsOn: ["pluto_pull", "sales_comps"] }),
  t("pipeline", "site_visit", "Site visit with photos", "Acquisitions", 5, { requiredAttachment: "Site photos" }),
  t("pipeline", "partner_approval_offer", "Partner approval to offer", "Acquisitions", 8, { ...A("Partner"), dependsOn: ["pro_forma", "mih_check", "e_designation_check", "lpc_check"] }),
  t("pipeline", "offer_sent", "Offer / LOI sent", "Acquisitions", 9, { dependsOn: ["partner_approval_offer"], hideIf: ["foreclosure"] }),

  // Under Contract
  t("under_contract", "contract_negotiated", "Contract negotiated by counsel", "Legal", 10),
  t("under_contract", "contract_signed", "Contract signed", "Legal", 12, { ...A(), dependsOn: ["contract_negotiated"], requiredAttachment: "Signed contract" }),
  t("under_contract", "deposit_wired", "Deposit wired to escrow", "Finance", 2, { after: "contract_signed", dependsOn: ["contract_signed"] }),
  t("under_contract", "key_dates_entered", "DD expiry and closing dates entered as key dates", "PM", 1, { after: "contract_signed", dependsOn: ["contract_signed"] }),
  t("under_contract", "assignment_rights", "Assignment rights confirmed", "Legal", 5, { showIf: ["contract_flip"] }),
  t("under_contract", "title_ordered", "Title ordered", "Legal", 2, { after: "contract_signed", hideIf: ["contract_flip"] }),
  t("under_contract", "entity_formed", "Buying entity formed, EIN, bank account", "Finance", 10, { after: "contract_signed", hideIf: ["contract_flip"] }),
  t("under_contract", "insurance_quotes", "Insurance quotes", "PM", 10, { after: "contract_signed", hideIf: ["contract_flip"] }),

  // Auction [foreclosure]
  t("auction", "terms_of_sale", "Terms of sale obtained from the referee / Foreclosure Office", "Legal", 2, { requiredAttachment: "Terms of sale" }),
  t("auction", "auction_title_search", "Title search", "Legal", 7),
  t("auction", "confirm_vacant", "Confirm vacant", "Acquisitions", 5),
  t("auction", "certified_check", "Deposit certified check ready", "Finance", 8, { dependsOn: ["terms_of_sale"] }),
  t("auction", "max_bid", "Max bid", "Acquisitions", 8, { ...A(), dependsOn: ["auction_title_search", "confirm_vacant"] }),
  t("auction", "attend_auction", "Attend the auction", "Acquisitions", 10, { dependsOn: ["max_bid", "certified_check"], milestone: true }),
  t("auction", "memorandum_of_sale", "Memorandum of sale signed", "Legal", 0, { after: "attend_auction", dependsOn: ["attend_auction"], requiredAttachment: "Memorandum of sale" }),
  t("auction", "closing_deadline", "Closing deadline entered per terms of sale", "PM", 1, { after: "memorandum_of_sale", dependsOn: ["memorandum_of_sale"] }),

  // Due Diligence
  t("due_diligence", "title_report", "Title report reviewed; exceptions cleared", "Legal", 15, { requiredAttachment: "Title report" }),
  t("due_diligence", "survey", "Survey ordered and reviewed", "PM", 15, { requiredAttachment: "Survey PDF" }),
  t("due_diligence", "phase_1", "Phase I ESA", "PM", 15, { requiredAttachment: "Phase I report" }),
  t("due_diligence", "phase_2", "Phase II if RECs found", "PM", 25, { dependsOn: ["phase_1"], description: "Only if the Phase I found recognized environmental conditions." }),
  t("due_diligence", "oer_path", "OER remedial path", "PM", 20, { showIf: ["e_designation"] }),
  t("due_diligence", "zoning_analysis", "Zoning analysis by architect / zoning counsel with ZR sections cited", "Design", 15, { requiredAttachment: "Zoning analysis" }),
  t("due_diligence", "condition_report", "Building condition / structural report", "Construction", 15, { types: EXISTING_BUILDING }),
  t("due_diligence", "tenant_dd", "Rent roll, leases, estoppels, DHCR registration history, tenant buyout / relocation plan", "Legal", 20, { showIf: ["occupied"], subItems: ["Rent roll", "Leases", "Estoppels", "DHCR registration history", "Buyout / relocation plan"] }),
  t("due_diligence", "geotech", "Geotech borings", "Construction", 15, { showIf: ["excavation"] }),
  t("due_diligence", "utility_capacity", "Utility capacity: Con Ed, DEP sewer / water", "Construction", 15),
  t("due_diligence", "fema_flood", "FEMA flood zone", "PM", 5, { showIf: ["flood_zone"] }),
  t("due_diligence", "violation_plan", "Violation clearance plan", "PM", 12, { showIf: ["violations"] }),
  t("due_diligence", "arrears_check", "Tax, water and sewer arrears check", "Finance", 5),
  t("due_diligence", "lpc_preapp", "LPC pre-application meeting", "Design", 15, { showIf: ["landmarked"] }),
  t("due_diligence", "loan_term_sheets", "Construction loan term sheets", "Finance", 20, { showIf: ["construction_loan"] }),
  t("due_diligence", "final_budget", "Final budget and pro forma", "Acquisitions", 22, { ...A(), dependsOn: ["zoning_analysis", "condition_report", "utility_capacity"] }),
  t("due_diligence", "go_no_go", "Go / no-go decision", "Owner", 25, { ...A(), dependsOn: ["final_budget", "title_report", "survey", "phase_1"], milestone: true }),

  // Closing
  t("closing", "loan_commitment", "Loan commitment and lender DD", "Finance", 10, { showIf: ["construction_loan"] }),
  t("closing", "closing_statement", "Title bill and closing statement reviewed", "Legal", 12, { ...A() }),
  t("closing", "transfer_tax", "Transfer tax / RPT forms", "Legal", 12),
  t("closing", "insurance_bound", "Builder's risk and GL insurance bound", "PM", 12, { requiredAttachment: "Insurance binder" }),
  t("closing", "funds_wired", "Funds wired", "Finance", 14, { dependsOn: ["closing_statement", "title_report", "go_no_go"] }),
  t("closing", "deed_recorded", "Deed recorded; ACRIS confirmation", "Legal", 10, { after: "funds_wired", dependsOn: ["funds_wired"] }),
  t("closing", "utilities_transferred", "Utilities transferred", "PM", 5, { after: "funds_wired", dependsOn: ["funds_wired"] }),
  t("closing", "site_secured", "Site secured: fence, signage, lock change", "Construction", 2, { after: "funds_wired", dependsOn: ["funds_wired"] }),
  t("closing", "jv_agreement", "JV agreement executed", "Legal", 12, { showIf: ["jv"], ...A("Partner") }),
  t("closing", "deadlines_1031", "1031 identification and closing deadlines", "Finance", 1, { showIf: ["exchange_1031"], description: "45 days to identify, 180 days to close. Enter both as key dates." }),

  // Marketing to End Buyers [contract flip]
  t("marketing", "flip_pricing", "Pricing", "Acquisitions", 3, { ...A() }),
  t("marketing", "buyer_outreach", "Buyer outreach", "Acquisitions", 10, { dependsOn: ["flip_pricing"] }),
  t("marketing", "buyer_dd_access", "Buyer DD access", "Acquisitions", 15, { dependsOn: ["buyer_outreach"] }),

  // Assignment [contract flip]
  t("assignment", "assignment_signed", "Assignment agreement signed", "Legal", 5, { requiredAttachment: "Assignment agreement" }),
  t("assignment", "seller_consent", "Seller consent if required", "Legal", 5),
  t("assignment", "assignment_fee", "Assignment fee received", "Finance", 10, { dependsOn: ["assignment_signed"], milestone: true }),

  // Design & Zoning
  t("design_zoning", "architect_engaged", "Architect engaged; fee approved", "Design", 10, { ...A() }),
  t("design_zoning", "schematic_design", "Schematic design with unit mix and sellable area", "Design", 30, { dependsOn: ["architect_engaged"] }),
  t("design_zoning", "zoning_diagram", "Zoning diagram", "Design", 25, { dependsOn: ["architect_engaged"] }),
  t("design_zoning", "engineers_engaged", "Structural and MEP engineers engaged", "Design", 20, { dependsOn: ["architect_engaged"] }),
  t("design_zoning", "expediter_engaged", "Expediter engaged", "PM", 20),
  t("design_zoning", "design_development", "Design development", "Design", 25, { after: "schematic_design", dependsOn: ["schematic_design"] }),
  t("design_zoning", "finish_spec", "High-end finish spec", "Design", 20, { after: "schematic_design", dependsOn: ["schematic_design"], hideIf: ["rental_hold"] }),
  t("design_zoning", "broker_layout_review", "Sales broker layout review", "Sales", 10, { after: "schematic_design", dependsOn: ["schematic_design"], hideIf: ["rental_hold"] }),
  t("design_zoning", "lpc_coa", "LPC Certificate of Appropriateness", "Design", 45, { showIf: ["landmarked"], after: "schematic_design", dependsOn: ["schematic_design"] }),
  t("design_zoning", "oer_rap", "OER Remedial Action Plan", "PM", 40, { showIf: ["e_designation"] }),
  t("design_zoning", "construction_documents", "Construction documents", "Design", 40, { ...A(), after: "design_development", dependsOn: ["design_development", "engineers_engaged"], milestone: true }),

  // DOB Filing & Approval
  t("dob_filing", "dob_filed", "DOB NOW job filed (NB, or ALT with new CO)", "PM", 5, { dependsOn: ["construction_documents", "expediter_engaged"], milestone: true }),
  t("dob_filing", "tr1", "Special inspections (TR1)", "PM", 5, { after: "dob_filed" }),
  t("dob_filing", "tr8", "Energy code (TR8)", "PM", 5, { after: "dob_filed" }),
  t("dob_filing", "objections", "Plan exam objections resolved", "PM", 30, { after: "dob_filed", dependsOn: ["dob_filed"] }),
  t("dob_filing", "dob_approval", "Approval received", "PM", 5, { after: "objections", dependsOn: ["objections"], milestone: true }),
  t("dob_filing", "asbestos", "Asbestos investigation and DEP ACP filings", "Construction", 15, { showIf: ["demolition"] }),
  t("dob_filing", "demo_permit", "Demolition permit", "PM", 25, { showIf: ["demolition"], dependsOn: ["asbestos"] }),
  t("dob_filing", "soe_design", "Support of excavation / underpinning design and adjacent monitoring", "Design", 25, { showIf: ["excavation"] }),
  t("dob_filing", "rpapl_881", "Neighbor access / license agreements (RPAPL 881)", "Legal", 30, { showIf: ["excavation"] }),
  t("dob_filing", "tenant_protection_plan", "Tenant Protection Plan", "PM", 15, { showIf: ["occupied"] }),
  t("dob_filing", "dep_site_connection", "DEP site connection proposal", "PM", 20),
  t("dob_filing", "dot_permits", "DOT permits: sidewalk shed, curb cut, crane", "PM", 25, { subItems: ["Sidewalk shed", "Curb cut", "Crane"] }),
  t("dob_filing", "coned_application", "Con Ed service application", "Construction", 20),
  t("dob_filing", "work_permits", "Work permits issued and posted", "PM", 10, { after: "dob_approval", dependsOn: ["dob_approval"], milestone: true }),

  // Pre-Construction
  t("pre_construction", "gc_bids", "GC bids leveled", "Construction", 15),
  t("pre_construction", "gc_selected", "GC selected", "Owner", 20, { ...A(), dependsOn: ["gc_bids"] }),
  t("pre_construction", "gc_contract", "GC contract signed", "Legal", 10, { ...A(), after: "gc_selected", dependsOn: ["gc_selected"], requiredAttachment: "Signed GC contract" }),
  t("pre_construction", "cois", "COIs received", "PM", 3, { after: "gc_contract", dependsOn: ["gc_contract"] }),
  t("pre_construction", "loan_closed", "Construction loan closed", "Finance", 25, { showIf: ["construction_loan"], dependsOn: ["gc_contract"] }),
  t("pre_construction", "baseline_schedule", "Baseline schedule", "Construction", 5, { after: "gc_contract", dependsOn: ["gc_contract"] }),
  t("pre_construction", "budget_locked", "Budget locked to contract / GMP", "Owner", 5, { ...A(), after: "gc_contract", dependsOn: ["gc_contract"] }),
  t("pre_construction", "adjacent_survey", "Pre-construction survey of adjoining buildings", "Construction", 15, { showIf: ["excavation"] }),
  t("pre_construction", "site_safety_plan", "Site safety plan if required", "Construction", 15),
  t("pre_construction", "shed_fence", "Sidewalk shed and fence installed", "Construction", 5, { after: "gc_contract", dependsOn: ["dot_permits"] }),

  // Construction — recurring
  t("construction", "oac_meeting", "Weekly OAC meeting", "PM", 5, { recurrence: { freq: "weekly" } }),
  t("construction", "weekly_photos", "Weekly site photos", "Construction", 5, { recurrence: { freq: "weekly" }, requiredAttachment: "Site photos" }),
  t("construction", "monthly_draw", "Monthly draw (requisition, lender inspector sign-off, lien waivers, retainage)", "Finance", 20, {
    showIf: ["construction_loan"],
    recurrence: { freq: "monthly" },
    subItems: ["Requisition", "Lender inspector sign-off", "Lien waivers", "Retainage"],
  }),
  t("construction", "co_review", "Change order review", "Owner", 20, { ...A(), recurrence: { freq: "monthly" } }),
  // Construction — milestones
  t("construction", "demo_complete", "Demo complete", "Construction", 20, { milestone: true, types: EXISTING_BUILDING }),
  t("construction", "excavation_foundation", "Excavation / foundation", "Construction", 45, { milestone: true, types: ["ground_up_condo"] }),
  t("construction", "topped_out", "Superstructure topped out", "Construction", 60, { after: "excavation_foundation", dependsOn: ["excavation_foundation"], milestone: true, types: ["ground_up_condo"] }),
  t("construction", "watertight", "Watertight envelope", "Construction", 30, { after: "topped_out", dependsOn: ["topped_out"], milestone: true, types: ["ground_up_condo"] }),
  t("construction", "mep_rough", "MEP rough-in", "Construction", 40, { milestone: true }),
  t("construction", "rough_inspections", "Rough inspections", "Construction", 5, { after: "mep_rough", dependsOn: ["mep_rough"] }),
  t("construction", "drywall", "Drywall", "Construction", 20, { after: "rough_inspections", dependsOn: ["rough_inspections"], milestone: true }),
  t("construction", "finishes", "Finishes", "Construction", 40, { after: "drywall", dependsOn: ["drywall"], milestone: true }),
  t("construction", "elevator", "Elevator (if applicable)", "Construction", 30, { after: "drywall", description: "Delete this task if the building has no elevator." }),
  t("construction", "punch_list", "Punch list", "Construction", 10, { after: "finishes", dependsOn: ["finishes"] }),
  t("construction", "controlled_inspections", "Controlled inspections logged", "Construction", 10, { after: "punch_list" }),
  t("construction", "utility_energization", "Utility energization", "Construction", 5, { after: "finishes", dependsOn: ["coned_application"] }),

  // TCO / CO
  t("tco_co", "final_inspections", "Final plumbing, electrical, elevator and FDNY inspections", "PM", 15, { subItems: ["Plumbing", "Electrical", "Elevator", "FDNY"] }),
  t("tco_co", "tr_signoffs", "TR1 / TR8 sign-offs", "PM", 15),
  t("tco_co", "tco_issued", "TCO issued", "PM", 5, { after: "final_inspections", dependsOn: ["final_inspections", "tr_signoffs"], milestone: true }),
  t("tco_co", "tco_renewals", "TCO renewal tracker with auto-reminders", "PM", 75, { after: "tco_issued", description: "TCOs run 90 days. Enter the expiry as a key date so reminders go out." }),
  t("tco_co", "final_co", "Final CO", "PM", 60, { after: "tco_issued", dependsOn: ["tco_issued"], milestone: true }),
  t("tco_co", "punch_complete", "Punch list complete", "Construction", 20, { after: "tco_issued" }),

  // AG Plan & Sales [condo exit]
  t("ag_plan_sales", "broker_engaged", "Sales broker engaged", "Sales", 10, { ...A() }),
  t("ag_plan_sales", "condo_counsel", "Condo counsel engaged", "Legal", 10),
  t("ag_plan_sales", "offering_plan_submitted", "Offering plan submitted to the NY AG", "Legal", 30, { dependsOn: ["condo_counsel"] }),
  t("ag_plan_sales", "accepted_for_filing", "Accepted for filing", "Legal", 60, { after: "offering_plan_submitted", dependsOn: ["offering_plan_submitted"], milestone: true }),
  t("ag_plan_sales", "pricing_schedule", "Pricing schedule", "Sales", 20, { ...A(), dependsOn: ["broker_engaged"] }),
  t("ag_plan_sales", "declaration_bylaws", "Declaration and bylaws", "Legal", 30, { dependsOn: ["condo_counsel"] }),
  t("ag_plan_sales", "dof_apportionment", "DOF tax lot apportionment", "Legal", 40),
  t("ag_plan_sales", "tax_incentive_filings", "485-x / 421-a filings", "Legal", 30, { showIf: ["tax_incentive"] }),
  t("ag_plan_sales", "marketing_materials", "Renderings, website, listings", "Sales", 25, { dependsOn: ["broker_engaged"] }),
  t("ag_plan_sales", "contract_tracker", "Per-unit contract tracker", "Sales", 10, { after: "accepted_for_filing" }),
  t("ag_plan_sales", "plan_effective", "Plan declared effective", "Legal", 60, { after: "accepted_for_filing", dependsOn: ["accepted_for_filing"], milestone: true }),
  t("ag_plan_sales", "unit_closings", "Unit closings with lender partial releases", "Legal", 30, { after: "plan_effective", dependsOn: ["plan_effective", "final_co"], showIf: ["construction_loan"] }),
  t("ag_plan_sales", "unit_closings_no_loan", "Unit closings", "Legal", 30, { after: "plan_effective", dependsOn: ["plan_effective", "final_co"], hideIf: ["construction_loan"] }),

  // Rental / Hold [rental hold]
  t("rental_hold", "lease_up_plan", "Lease-up plan", "Sales", 10),
  t("rental_hold", "registration_filings", "Registration filings as required", "Legal", 20, { description: "DHCR registration and any tax-incentive filings that apply." }),
  t("rental_hold", "perm_refi", "Permanent loan refinance", "Finance", 90, { dependsOn: ["lease_up_plan"] }),

  // Sold Out / Closed
  t("closed", "final_closings", "Final closings", "Legal", 20, { hideIf: ["contract_flip", "rental_hold"] }),
  t("closed", "lender_payoff", "Lender payoff", "Finance", 20, { showIf: ["construction_loan"] }),
  t("closed", "final_accounting", "Final accounting", "Finance", 30),
  t("closed", "jv_waterfall", "JV distribution waterfall", "Finance", 40, { showIf: ["jv"], dependsOn: ["final_accounting"], ...A("Partner") }),
  t("closed", "condo_board_transfer", "Transfer to condo board", "PM", 30, { hideIf: ["rental_hold", "contract_flip"], types: BUILD_TYPES }),
  t("closed", "warranty_tracker", "Warranty-period tracker", "PM", 30, { types: BUILD_TYPES }),
  t("closed", "archive_files", "Archive project files", "PM", 45, { dependsOn: ["final_accounting"] }),
];

export const DEFAULT_FOLDERS = [
  "Acquisition",
  "Legal",
  "Title & Survey",
  "Environmental",
  "Design",
  "DOB & Permits",
  "Construction",
  "Photos",
  "Financial",
  "Sales",
  "Closeout",
] as const;

const TYPE_NAMES: Record<ProjectTypeKey, string> = {
  ground_up_condo: "Ground-up condo",
  gut_renovation: "Gut renovation / townhouse conversion",
  contract_flip: "Contract flip",
  foreclosure_auction: "Foreclosure auction buy",
  condo_conversion: "Condo conversion",
};

/** The default template for a project type, assembled from the library. */
export function defaultTemplate(type: ProjectTypeKey): TemplateDef {
  const phaseKeys = PHASE_ORDER[type];
  const phases = phaseKeys.map((k) => ({ ...LIBRARY_PHASES[k]! }));
  const inPhase = new Set(phaseKeys);
  const tasks = LIBRARY_TASKS.filter((k) => inPhase.has(k.phaseKey) && (!k.types || k.types.includes(type)))
    // Library order within each phase, phases in track order.
    .sort((a, b) => phaseKeys.indexOf(a.phaseKey) - phaseKeys.indexOf(b.phaseKey));
  const keys = new Set(tasks.map((k) => k.key));
  const clean: TemplateTaskDef[] = tasks.map(({ types: _types, ...k }) => {
    void _types;
    const dependsOn = (k.dependsOn ?? []).filter((d) => keys.has(d));
    // A relative-date anchor that isn't in this template falls back to the phase start.
    const due = typeof k.due.from === "object" && !keys.has(k.due.from.task) ? { ...k.due, from: "phase_start" as const } : k.due;
    return { ...k, dependsOn, due };
  });
  return {
    name: TYPE_NAMES[type],
    projectType: type,
    description: `Default checklist for ${TYPE_NAMES[type].toLowerCase()} projects.`,
    phases,
    tasks: clean,
    folders: [...DEFAULT_FOLDERS],
  };
}

export const DEFAULT_TEMPLATE_TYPES: ProjectTypeKey[] = ["ground_up_condo", "gut_renovation", "condo_conversion", "foreclosure_auction", "contract_flip"];
