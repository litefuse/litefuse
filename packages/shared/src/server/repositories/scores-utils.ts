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
  const query = `
      SELECT *
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
      SELECT *
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
