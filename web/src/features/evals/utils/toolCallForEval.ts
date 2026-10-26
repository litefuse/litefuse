// LITEFUSE NOTE (authored file, not an upstream copy) ───────────────────────
// Upstream declares \`toolCallForEvalSchema\` / \`ToolCallForEval\` in
// \`packages/shared/src/features/evals/observationForEval.ts\`. Our version of
// that file does not have them, and adding them there would mean editing a file
// outside the evaluator module. The shape below is copied from upstream.
// ─────────────────────────────────────────────────────────────────────────────
import { z } from "zod/v4";

export const toolCallForEvalSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.unknown(),
  type: z.string(),
  index: z.number(),
});

export type ToolCallForEval = z.infer<typeof toolCallForEvalSchema>;
