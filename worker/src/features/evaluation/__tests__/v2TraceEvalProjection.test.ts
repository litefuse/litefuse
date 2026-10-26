import { describe, expect, it } from "vitest";
import { EvalTemplateType } from "@langfuse/shared";
import { toLegacyTraceConfigRow, type V2TraceRule } from "../evalService";

/**
 * Unit tests for the evaluators v2 → legacy `job_configurations` projection that
 * lets the trace/dataset executor run migrated rules. The projection is pure, so
 * these tests need no database: they pin down exactly which v2 rules the worker
 * is willing to execute and how each field is carried over.
 */
function buildRule(overrides: {
  assignmentCount?: number;
  evaluatorType?: EvalTemplateType;
  blockedAt?: Date | null;
  hasVersion?: boolean;
  dataType?: string | null;
  versionOverrides?: Partial<{
    id: string;
    prompt: string | null;
    promptMessages: unknown;
    vars: string[];
    outputDefinition: unknown;
  }>;
  assignmentVariableMapping?: unknown;
  ruleOverrides?: Partial<{ status: "ACTIVE" | "INACTIVE" }>;
}): V2TraceRule {
  const {
    assignmentCount = 1,
    evaluatorType = EvalTemplateType.LLM_AS_JUDGE,
    blockedAt = null,
    hasVersion = true,
    dataType = "NUMERIC",
    versionOverrides = {},
    assignmentVariableMapping = null,
    ruleOverrides = {},
  } = overrides;

  const versions = hasVersion
    ? [
        {
          id: "version-1",
          version: 3,
          prompt: "Judge {{input}}",
          promptMessages: [
            { role: "system", content: "You are a judge." },
            { role: "user", content: "Input: {{input}}" },
          ],
          vars: ["input", "output"],
          provider: "openai",
          model: "gpt-4o-mini",
          modelParams: { temperature: 0 },
          variableMapping: [
            { templateVariable: "input", selectedColumnId: "input" },
          ],
          outputDefinition: { dataType },
          ...versionOverrides,
        },
      ]
    : [];

  return {
    id: "rule-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    projectId: "project-1",
    status: ruleOverrides.status ?? "ACTIVE",
    filter: [
      {
        column: "environment",
        operator: "none of",
        value: ["langfuse"],
        type: "stringOptions",
      },
    ],
    targetObject: "trace",
    sampling: "0.5",
    delay: 0,
    timeScope: ["NEW"],
    assignments: Array.from({ length: assignmentCount }, (_unused, index) => ({
      id: `assignment-${index}`,
      variableMapping: assignmentVariableMapping,
      evaluator: {
        id: "evaluator-1",
        name: "Quality judge",
        type: evaluatorType,
        blockedAt,
        versions,
      },
    })),
  } as unknown as V2TraceRule;
}

describe("toLegacyTraceConfigRow", () => {
  it("projects a numeric single-assignment LLM judge rule", () => {
    const row = toLegacyTraceConfigRow(buildRule({}));

    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      id: "rule-1",
      project_id: "project-1",
      job_type: "EVAL",
      status: "ACTIVE",
      // The evaluator VERSION is the template id: there is no eval_templates row.
      eval_template_id: "version-1",
      score_name: "Quality judge",
      target_object: "trace",
      // Prisma Decimal → string, as the Kysely row type expects.
      sampling: "0.5",
      delay: 0,
      time_scope: ["NEW"],
      // Not a job_configurations column: carried onto the queued execution event.
      evaluatorId: "evaluator-1",
    });
    expect(row?.created_at).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("falls back to the version variable mapping when the assignment has none", () => {
    const row = toLegacyTraceConfigRow(buildRule({}));
    expect(row?.variable_mapping).toEqual([
      { templateVariable: "input", selectedColumnId: "input" },
    ]);
  });

  it("prefers the assignment variable mapping when present", () => {
    const mapping = [
      { templateVariable: "output", selectedColumnId: "output" },
    ];
    const row = toLegacyTraceConfigRow(
      buildRule({ assignmentVariableMapping: mapping }),
    );
    expect(row?.variable_mapping).toEqual(mapping);
  });

  it("skips rules with more than one assignment (event/experiment shape)", () => {
    expect(
      toLegacyTraceConfigRow(buildRule({ assignmentCount: 2 })),
    ).toBeNull();
  });

  it("skips blocked evaluators", () => {
    expect(
      toLegacyTraceConfigRow(buildRule({ blockedAt: new Date() })),
    ).toBeNull();
  });

  it("projects decision-model rules (Litefuse runs them on the trace path too)", () => {
    // Deliberate deviation from upstream, whose trace/dataset path only runs
    // LLM judges: our rule UI lets a rule target a decision-model evaluator, so
    // the projection must not drop those rules. See 待决问题登记.md.
    const row = toLegacyTraceConfigRow(
      buildRule({ evaluatorType: EvalTemplateType.DECISION_MODEL }),
    );
    expect(row).not.toBeNull();
    expect(row?.eval_template_id).toBe("version-1");
  });

  it("skips evaluator types this path cannot run", () => {
    expect(
      toLegacyTraceConfigRow(
        buildRule({ evaluatorType: EvalTemplateType.CODE }),
      ),
    ).toBeNull();
  });

  it("skips evaluators without a version", () => {
    expect(toLegacyTraceConfigRow(buildRule({ hasVersion: false }))).toBeNull();
  });

  it("accepts every output data type the v2 executor supports", () => {
    // All three run through `runV2LlmEvaluatorEvaluation`, which compiles the
    // matching result schema per data type.
    for (const dataType of ["NUMERIC", "BOOLEAN", "CATEGORICAL"]) {
      const row = toLegacyTraceConfigRow(buildRule({ dataType }));
      expect(row, dataType).not.toBeNull();
      expect(row?.eval_template_id, dataType).toBe("version-1");
    }
  });

  it("projects a migrated legacy evaluator whose output definition is the legacy shape", () => {
    // Every pre-v2 row goes through the evaluators v2 backfill, which copies
    // `eval_templates.output_schema` verbatim into `evaluator_versions.
    // output_definition` — and that column holds `{ score, reasoning }` for those
    // rows, not the dataType-discriminated shape. The shared resolver normalises
    // it to NUMERIC (what the legacy UI labelled "Numeric"), which is exactly what
    // `executeLlmEvaluator` compiles with, so the rule must stay executable here.
    const row = toLegacyTraceConfigRow(
      buildRule({
        versionOverrides: {
          outputDefinition: {
            score: "A number between 0 and 1",
            reasoning: "Why that score was given",
          },
        } as never,
      }),
    );

    expect(row).not.toBeNull();
    expect(row?.eval_template_id).toBe("version-1");
  });

  it("skips rules whose output definition is missing or unknown", () => {
    expect(
      toLegacyTraceConfigRow(
        buildRule({ versionOverrides: { outputDefinition: null } as never }),
      ),
    ).toBeNull();
    expect(
      toLegacyTraceConfigRow(
        buildRule({ versionOverrides: { outputDefinition: {} } as never }),
      ),
    ).toBeNull();
    expect(toLegacyTraceConfigRow(buildRule({ dataType: "TEXT" }))).toBeNull();
  });

  it("still projects an inactive rule (the executor cancels it, the scheduler filters it)", () => {
    const row = toLegacyTraceConfigRow(
      buildRule({ ruleOverrides: { status: "INACTIVE" } }),
    );
    expect(row?.status).toBe("INACTIVE");
  });
});
