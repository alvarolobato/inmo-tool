/**
 * Zod schemas and types for weekly review v2 (structured, evidence-backed).
 */

import { z } from "zod";
import { REVIEW_QUERIES } from "./review-queries";

const _names = REVIEW_QUERIES.map((q) => q.name);
export const ReviewQueryNameSchema = z.enum(_names as [string, ...string[]]);

export const REVIEW_DASHBOARD_KEYS = [
  "ventas_retail",
  "canal_mayorista",
  "stock",
  "compras",
] as const;
export type ReviewDashboardKey = (typeof REVIEW_DASHBOARD_KEYS)[number];

export const ReviewDashboardKeySchema = z.enum(REVIEW_DASHBOARD_KEYS);

const SectionDomainKeySchema = z.enum(REVIEW_DASHBOARD_KEYS);

export const ReviewEvidenceDetailSchema = z.object({
  query_name: z.string().min(1),
  snapshot: z.string().min(1),
  error: z.string().optional(),
});

export type ReviewEvidenceDetail = z.infer<typeof ReviewEvidenceDetailSchema>;

/** True if `YYYY-MM-DD` is a real calendar date in the local Gregorian interpretation. */
export function isCalendarIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map((x) => parseInt(x, 10));
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
}

const ReviewSectionLlmSchema = z.object({
  key: SectionDomainKeySchema,
  title: z.string().min(1),
  narrative: z.string().min(1),
  kpis: z.array(z.string()).min(1).max(10),
  evidence_queries: z.array(ReviewQueryNameSchema).min(1).max(8),
  dashboard_key: ReviewDashboardKeySchema,
});

const ReviewActionLlmSchema = z.object({
  action_key: z.string().regex(/^[a-z0-9_]{1,64}$/),
  priority: z.enum(["alta", "media", "baja"]),
  owner_role: z.string().min(1).max(120),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isCalendarIsoDate, { message: "due_date must be a valid calendar date" }),
  action: z.string().min(1),
  expected_impact: z.string().min(1).max(500),
  evidence_queries: z.array(ReviewQueryNameSchema).min(1).max(6),
  dashboard_key: ReviewDashboardKeySchema,
});

export const ReviewSectionV2Schema = ReviewSectionLlmSchema.extend({
  evidence: z.array(ReviewEvidenceDetailSchema).optional(),
  dashboard_url: z.string().min(1).optional(),
});

export type ReviewSectionV2 = z.infer<typeof ReviewSectionV2Schema>;

export const ReviewActionItemV2Schema = ReviewActionLlmSchema.extend({
  owner_name: z.string().max(120).default(""),
  evidence: z.array(ReviewEvidenceDetailSchema).optional(),
  dashboard_url: z.string().min(1).optional(),
});

export type ReviewActionItemV2 = z.infer<typeof ReviewActionItemV2Schema>;

export const ReviewLlmOutputSchema = z
  .object({
    executive_summary: z.array(z.string().min(1)).min(3).max(5),
    sections: z.array(ReviewSectionLlmSchema).length(4),
    action_items: z.array(ReviewActionLlmSchema).min(3).max(8),
    data_quality_notes: z.array(z.string()).max(16).default([]),
    generated_at: z.string().min(10),
  })
  .strict()
  .superRefine((val, ctx) => {
    const keys = new Set(val.sections.map((s) => s.key));
    if (keys.size !== 4) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sections keys must be unique" });
    }
    for (const k of REVIEW_DASHBOARD_KEYS) {
      if (!keys.has(k)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `missing section key ${k}`,
        });
      }
    }
  });

export type ReviewLlmOutput = z.infer<typeof ReviewLlmOutputSchema>;

export const ReviewContentV2Schema = z.object({
  review_schema_version: z.literal(2),
  executive_summary: z.array(z.string().min(1)).min(3).max(5),
  sections: z.array(ReviewSectionV2Schema).length(4),
  action_items: z.array(ReviewActionItemV2Schema).min(3).max(8),
  data_quality_notes: z.array(z.string()).max(32),
  generated_at: z.string().min(10),
  quality_status: z.enum(["ok", "degraded"]).default("ok"),
});

export type ReviewContent = z.infer<typeof ReviewContentV2Schema>;
