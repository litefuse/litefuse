import { ScoreDataTypeType, ScoreDomain, ScoreSourceType } from "../../domain";
import { queryDoris } from "./doris";
import { ScoreRecordReadType } from "./definitions";
import { convertDorisScoreToDomain } from "./scores_converters";

/**
 * @internal
 * Internal utility function for getting scores by ID.
 * Do not use directly - use ScoresApiService or repository functions instead.
 */
export const _handleGetScoreById = async ({
  projectId,
  scoreId,
  source,
  scoreScope,
}: {
  projectId: string;
  scoreId: string;
  source?: ScoreSourceType;
  scoreScope: "traces_only" | "all";
  scoreDataTypes?: readonly ScoreDataTypeType[];
}): Promise<ScoreDomain | undefined> => {
  // `metadata` is re-selected as JSON: Doris renders a MAP<TEXT,TEXT> column by
  // concatenating its raw values without escaping quotes, which made every map
  // holding nested JSON invalid JSON for `parseMetadataCHRecordToDomain` (it
  // silently degraded to `{}`). The duplicate column name resolves to the
  // JSON-typed one, which mysql2 already parses into an object.
  const query = `
      SELECT *, to_json(metadata) AS metadata
      FROM scores s
      WHERE s.project_id = {projectId: String}
      AND s.id = {scoreId: String}
      ${source ? `AND s.source = {source: String}` : ""}
      ${scoreScope === "traces_only" ? "AND s.session_id IS NULL AND s.dataset_run_id IS NULL" : ""}
      LIMIT 1
    `;

  const rows = await queryDoris<ScoreRecordReadType>({
    query,
    params: {
      projectId,
      scoreId,
      ...(source !== undefined ? { source } : {}),
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "byId",
      projectId,
    },
  });
  return rows.map((r) => convertDorisScoreToDomain(r)).shift();
};

/**
 * @internal
 * Internal utility function for getting scores by ID.
 * Do not use directly - use ScoresApiService or repository functions instead.
 */
export const _handleGetScoresByIds = async ({
  projectId,
  scoreId,
  source,
  scoreScope,
  dataTypes,
}: {
  projectId: string;
  scoreId: string[];
  source?: ScoreSourceType;
  scoreScope: "traces_only" | "all";
  dataTypes?: readonly ScoreDataTypeType[];
}): Promise<ScoreDomain[]> => {
  const query = `
      SELECT *, to_json(metadata) AS metadata
      FROM scores s
      WHERE s.project_id = {projectId: String}
      AND s.id IN ({scoreId: Array(String)})
      ${source ? `AND s.source = {source: String}` : ""}
      ${scoreScope === "traces_only" ? "AND s.session_id IS NULL AND s.dataset_run_id IS NULL" : ""}
      ORDER BY event_ts DESC
    `;

  const rows = await queryDoris<ScoreRecordReadType>({
    query,
    params: {
      projectId,
      scoreId,
      ...(source !== undefined ? { source } : {}),
    },
    tags: {
      feature: "tracing",
      type: "score",
      kind: "byId",
      projectId,
    },
  });
  return rows.map((r) => convertDorisScoreToDomain(r));
};
