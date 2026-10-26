-- Convert the legacy evaluators that 20261013000000_backfill_evaluator_v2
-- carried over into evaluators the *new* evaluation workflow can actually run.
--
-- The backfill copied properties verbatim that the new workflow cannot consume,
-- so every migrated legacy rule is dead on arrival. Four distinct problems,
-- each verified against a running stack:
--
--   1. RE-KEYING (this is why the rule ids below are prefixed).
--      `observationEvalProcessor` decides legacy vs v2 per job by looking the
--      job's `jobConfigurationId` up in `job_configurations`:
--          const evalJobConfig = await prisma.jobConfiguration.findFirst({ where: { id: job.jobConfigurationId } });
--          const isLegacyExecution = Boolean(evalJobConfig?.evalTemplate);
--      The job's `jobConfigurationId` *is* the rule id, and the backfill set
--      `evaluation_rules.id = job_configurations.id`, so the lookup keeps
--      matching a legacy row and the job runs on the legacy executor — which
--      resolves model and prompt from `eval_templates`, not from the converted
--      evaluator. Observed: the converted rules were scheduled correctly (5
--      jobs, event + root filter) and every one of them called the provider
--      with `gpt-4o-mini`, the legacy template's model, instead of the
--      evaluator's `deepseek-flash` → HTTP 400 from the DeepSeek connection.
--      Giving the converted rules fresh ids moves them onto the v2 executors.
--
--   2. `target_object` stayed 'trace'. The new scheduler only ever fetches
--      `event` / `experiment` rules
--      (worker/src/features/evaluation/observationEval/fetchObservationEvalConfigs.ts)
--      and the Doris ingestion path no longer enqueues the trace-upsert job
--      that used to run trace rules: worker/src/queues/otelIngestionQueue.ts
--      gates that legacy dual write behind `legacyDualWrite()`, hard-coded to
--      `false`. Verified: 5 active trace rules, a trace ingested, and
--      `job_executions` stayed empty while `bull:trace-upsert` never received
--      a job.
--
--   3. The prompt states no output contract. DeepSeek — the judge provider
--      configured here — only supports jsonMode, so LangChain sends
--      `response_format: {"type":"json_object"}` and never the schema: field
--      names, types and every `describe()` note are dropped. A judge whose
--      prompt omits the contract returns an invented shape
--      (`{"score": 1, "reason": "…"}` instead of
--      `{"score": …, "reasoning": "…"}`) which fails to parse; a parse failure
--      is classified as retryable, so the job retries with exponential backoff
--      and spends one real model call per attempt. Verified: writing the
--      contract into `prompt_messages` makes all three judges pass with the
--      very same model.
--
--   4. `prompt_messages` was left NULL while the runtime prefers it over
--      `prompt` (`getEvaluatorPromptMessages`), so a converted evaluator has to
--      state the contract there as well.
--
-- Semantics: a legacy 'trace' rule evaluated each trace once. The new model
-- evaluates observations, so the rule is pointed at the trace's *root*
-- observation — the same filter the new-rule dialog ships as its default
-- (web/src/features/evals/v2/components/Rules/CreateRuleDialog/…/resolveInitialRuleFilters.ts).
-- One evaluation per trace is preserved instead of one per observation.
--
-- Everything else the backfill produced (name, model, provider, model_params,
-- vars, variable_mapping, sampling, status, time_scope, recorded evaluations)
-- is left untouched, and the legacy tables stay in place until the old
-- workflow is removed for good.

-- 1. Re-key the legacy-derived rules under new ids, converted to event rules
--    narrowed to the root observation. Scoped by `jc.id = r.id`, the identity
--    the backfill used, so rules a user created natively are never touched.
INSERT INTO "evaluation_rules" (
  "id", "created_at", "updated_at", "project_id", "name", "status",
  "target_object", "filter", "sampling", "delay", "time_scope"
)
SELECT
  'evr_' || r."id",
  r."created_at",
  now(),
  r."project_id",
  r."name",
  r."status",
  'event',
  '[{"column":"isRootObservation","type":"boolean","operator":"=","value":true}]'::jsonb,
  r."sampling",
  r."delay",
  r."time_scope"
FROM "evaluation_rules" r
JOIN "job_configurations" jc ON jc."id" = r."id" AND jc."job_type" = 'EVAL'
ON CONFLICT ("id") DO NOTHING;

-- 2. Point the evaluator assignments at the re-keyed rules *before* the old
--    rows go away: the assignment FK is ON DELETE CASCADE.
UPDATE "evaluation_rule_evaluator_assignments" a
SET "evaluation_rule_id" = 'evr_' || a."evaluation_rule_id"
WHERE EXISTS (
    SELECT 1
    FROM "job_configurations" jc
    WHERE jc."id" = a."evaluation_rule_id"
      AND jc."job_type" = 'EVAL'
  )
  AND EXISTS (
    SELECT 1
    FROM "evaluation_rules" r
    WHERE r."id" = 'evr_' || a."evaluation_rule_id"
  );

-- 3. Drop the colliding rules. Their ids are the legacy job configuration ids,
--    which is exactly what kept the processor on the legacy executor.
DELETE FROM "evaluation_rules" r
WHERE EXISTS (
    SELECT 1
    FROM "job_configurations" jc
    WHERE jc."id" = r."id"
      AND jc."job_type" = 'EVAL'
  )
  AND EXISTS (
    SELECT 1
    FROM "evaluation_rules" nr
    WHERE nr."id" = 'evr_' || r."id"
  );

-- 4. Converted evaluator versions: normalise the output definition and state
--    the contract in `prompt_messages` (keeping `prompt` in sync for the
--    editor). Guarded by `prompt_messages IS NULL`, the state the backfill
--    leaves, so the statements are a no-op on a second run and for evaluators a
--    user created natively.
WITH legacy_versions AS (
  SELECT
    v."id",
    COALESCE(v."prompt", '') AS "prompt",
    -- The backfill wrote the legacy descriptive shape, e.g.
    -- {"score": "number 0-1", "reasoning": "why"}, which the v2 resolver still
    -- accepts. Fall back to a plain 0..1 numeric judge if a template had none.
    COALESCE(v."output_definition"->>'score', 'number between 0 and 1') AS "score_description",
    COALESCE(v."output_definition"->>'reasoning', 'short explanation') AS "reasoning_description"
  FROM "evaluator_versions" v
  JOIN "evaluators" e ON e."id" = v."evaluator_id"
  JOIN "job_configurations" jc ON jc."id" = e."id" AND jc."job_type" = 'EVAL'
  WHERE v."prompt_messages" IS NULL
),
classified_versions AS (
  SELECT
    lv.*,
    CASE
      WHEN lv."score_description" ~* 'bool|true|false' THEN 'BOOLEAN'
      ELSE 'NUMERIC'
    END AS "data_type",
    -- Bounds read off the legacy description: "number 0-1", "0 to 1", "1..5".
    COALESCE(
      (regexp_match(lv."score_description", '(-?[0-9]+(?:\.[0-9]+)?)\s*(?:-|to|\.\.)\s*(-?[0-9]+(?:\.[0-9]+)?)'))[1],
      '0'
    )::numeric AS "min_value",
    COALESCE(
      (regexp_match(lv."score_description", '(-?[0-9]+(?:\.[0-9]+)?)\s*(?:-|to|\.\.)\s*(-?[0-9]+(?:\.[0-9]+)?)'))[2],
      '1'
    )::numeric AS "max_value"
  FROM legacy_versions lv
),
prepared_versions AS (
  SELECT
    cv.*,
    CASE
      WHEN cv."data_type" = 'BOOLEAN'
        THEN '{"score": true or false, "reasoning": "short explanation"}'
      ELSE format(
        '{"score": number between %s and %s, "reasoning": "short explanation"}',
        cv."min_value",
        cv."max_value"
      )
    END AS "contract",
    CASE
      WHEN cv."data_type" = 'BOOLEAN' THEN jsonb_build_object(
        'dataType', 'BOOLEAN',
        'score', jsonb_build_object('description', cv."score_description"),
        'reasoning', jsonb_build_object('description', cv."reasoning_description")
      )
      ELSE jsonb_build_object(
        'dataType', 'NUMERIC',
        'score', jsonb_build_object(
          'description', cv."score_description",
          'minValue', cv."min_value",
          'maxValue', cv."max_value"
        ),
        'reasoning', jsonb_build_object('description', cv."reasoning_description")
      )
    END AS "output_definition"
  FROM classified_versions cv
)
UPDATE "evaluator_versions" v
SET
  "prompt" = p."prompt"
    || E'\n\nReply with a single JSON object and nothing else, in exactly this shape:\n'
    || p."contract",
  "prompt_messages" = jsonb_build_array(
    jsonb_build_object(
      'role', 'system',
      'content', 'You are an expert evaluator. Judge the assistant output and reply with the requested JSON object only.'
    ),
    jsonb_build_object(
      'role', 'user',
      'content', p."prompt"
        || E'\n\nReply with a single JSON object and nothing else, in exactly this shape:\n'
        || p."contract"
    )
  ),
  "output_definition" = p."output_definition"
FROM prepared_versions p
WHERE v."id" = p."id";
