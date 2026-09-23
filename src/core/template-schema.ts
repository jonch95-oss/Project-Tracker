/**
 * Runtime shape of a template definition (what the Template studio saves).
 * Structural checks live here; relational checks (references, cycles) are
 * in validateTemplate().
 */
import { z } from "zod";
import { RECURRENCE_FREQS, type TemplateDef } from "./templates";

const key = z.string().trim().min(1).max(60).regex(/^[a-z0-9_]+$/, "Keys use lowercase letters, digits and _");
const toggleList = z.array(z.string().trim().min(1).max(60)).max(20).optional();
const PROJECT_TYPES = ["ground_up_condo", "gut_renovation", "contract_flip", "foreclosure_auction", "condo_conversion"] as const;

export const dueRuleSchema = z.object({
  days: z.number().int().min(0).max(3650),
  unit: z.enum(["business", "calendar"]),
  from: z.union([z.literal("phase_start"), z.object({ task: key })]),
});

export const templateTaskSchema = z.object({
  key,
  phaseKey: key,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).nullish(),
  role: z.string().trim().min(1).max(60),
  due: dueRuleSchema,
  requiresApproval: z.boolean().optional(),
  approverRole: z.string().trim().max(60).nullish(),
  dependsOn: z.array(key).max(50).optional(),
  subItems: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  requiredAttachment: z.string().trim().max(120).nullish(),
  recurrence: z.object({ freq: z.enum(RECURRENCE_FREQS) }).nullish(),
  killScreen: z.boolean().optional(),
  milestone: z.boolean().optional(),
  showIf: toggleList,
  hideIf: toggleList,
});

export const templatePhaseSchema = z.object({
  key,
  name: z.string().trim().min(1).max(80),
  showIf: toggleList,
  hideIf: toggleList,
});

export const templateDefSchema = z.object({
  name: z.string().trim().min(1).max(120),
  projectType: z.enum(PROJECT_TYPES),
  description: z.string().trim().max(2000).nullish(),
  phases: z.array(templatePhaseSchema).min(1).max(40),
  tasks: z.array(templateTaskSchema).max(1000),
  folders: z.array(z.string().trim().min(1).max(80)).max(60).optional(),
}) satisfies z.ZodType<TemplateDef>;

/** Parse stored JSON back into a definition (throws if it was corrupted). */
export function parseTemplateDef(json: unknown): TemplateDef {
  return templateDefSchema.parse(json);
}
