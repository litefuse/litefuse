import { convertDateToAnalyticsDateTime } from "./analytics";
import { queryDoris } from "./doris";

export const BILLING_METER_EVENT_NAME = "litefuse_units";
export const CLOUD_USAGE_METERING_CRON_NAME = "cloud-usage-metering-hourly";

export type BillingUnitCountByProjectAndDay = {
  projectId: string;
  date: string;
  traces: number;
  observations: number;
  scores: number;
  total: number;
};

export type BillingProjectWindow = {
  projectId: string;
  start: Date;
};

export type BillingUnitCount = {
  traces: number;
  observations: number;
  scores: number;
  total: number;
};

const PROJECT_WINDOW_CHUNK_SIZE = 250;

function endClause(end?: Date) {
  return end ? "AND created_at < {end: DateTime}" : "";
}

export async function getBillingUnitCountForProjects(params: {
  projectIds: string[];
  start: Date;
  end?: Date;
}): Promise<BillingUnitCount> {
  if (params.projectIds.length === 0) {
    return { traces: 0, observations: 0, scores: 0, total: 0 };
  }

  const queryParams = {
    projectIds: params.projectIds,
    start: convertDateToAnalyticsDateTime(params.start),
    ...(params.end ? { end: convertDateToAnalyticsDateTime(params.end) } : {}),
  };
  const [eventRows, scoreRows] = await Promise.all([
    queryDoris<{ traces: string; observations: string }>({
      query: `
        SELECT
          SUM(CASE WHEN parent_span_id = '' THEN 1 ELSE 0 END) AS traces,
          COUNT(*) AS observations
        FROM events_full
        WHERE project_id IN ({projectIds: Array(String)})
          AND created_at >= {start: DateTime}
          ${endClause(params.end)}
      `,
      params: queryParams,
      tags: { feature: "billing", type: "units", kind: "analytic" },
    }),
    queryDoris<{ scores: string }>({
      query: `
        SELECT COUNT(*) AS scores
        FROM scores
        WHERE project_id IN ({projectIds: Array(String)})
          AND created_at >= {start: DateTime}
          ${endClause(params.end)}
      `,
      params: queryParams,
      tags: { feature: "billing", type: "units", kind: "analytic" },
    }),
  ]);

  const traces = Number(eventRows[0]?.traces ?? 0);
  const observations = Number(eventRows[0]?.observations ?? 0);
  const scores = Number(scoreRows[0]?.scores ?? 0);
  return {
    traces,
    observations,
    scores,
    total: traces + observations + scores,
  };
}

export async function getBillingUnitCountsForProjectWindows(params: {
  windows: BillingProjectWindow[];
  end: Date;
}): Promise<Map<string, number>> {
  const totals = new Map(params.windows.map(({ projectId }) => [projectId, 0]));

  for (
    let offset = 0;
    offset < params.windows.length;
    offset += PROJECT_WINDOW_CHUNK_SIZE
  ) {
    const chunk = params.windows.slice(
      offset,
      offset + PROJECT_WINDOW_CHUNK_SIZE,
    );
    if (chunk.length === 0) continue;
    const predicates = chunk.map(
      (_, index) =>
        `(project_id = {projectId${index}: String} AND created_at >= {start${index}: DateTime})`,
    );
    const queryParams = Object.fromEntries(
      chunk.flatMap((window, index) => [
        [`projectId${index}`, window.projectId],
        [`start${index}`, convertDateToAnalyticsDateTime(window.start)],
      ]),
    );
    const sharedParams = {
      ...queryParams,
      end: convertDateToAnalyticsDateTime(params.end),
    };
    const [eventRows, scoreRows] = await Promise.all([
      queryDoris<{
        project_id: string;
        traces: string;
        observations: string;
      }>({
        query: `
          SELECT
            project_id,
            SUM(CASE WHEN parent_span_id = '' THEN 1 ELSE 0 END) AS traces,
            COUNT(*) AS observations
          FROM events_full
          WHERE created_at < {end: DateTime}
            AND (${predicates.join(" OR ")})
          GROUP BY project_id
        `,
        params: sharedParams,
        tags: { feature: "billing", type: "units", kind: "analytic" },
      }),
      queryDoris<{ project_id: string; scores: string }>({
        query: `
          SELECT project_id, COUNT(*) AS scores
          FROM scores
          WHERE created_at < {end: DateTime}
            AND (${predicates.join(" OR ")})
          GROUP BY project_id
        `,
        params: sharedParams,
        tags: { feature: "billing", type: "units", kind: "analytic" },
      }),
    ]);

    for (const row of eventRows) {
      totals.set(
        row.project_id,
        (totals.get(row.project_id) ?? 0) +
          Number(row.traces) +
          Number(row.observations),
      );
    }
    for (const row of scoreRows) {
      totals.set(
        row.project_id,
        (totals.get(row.project_id) ?? 0) + Number(row.scores),
      );
    }
  }

  return totals;
}

export async function getBillingUnitCountsByProjectAndDay(params: {
  start: Date;
  end: Date;
}): Promise<BillingUnitCountByProjectAndDay[]> {
  const [eventRows, scoreRows] = await Promise.all([
    queryDoris<{
      project_id: string;
      date: string;
      traces: string;
      observations: string;
    }>({
      query: `
        SELECT
          project_id,
          CAST(created_at AS DATE) AS date,
          SUM(CASE WHEN parent_span_id = '' THEN 1 ELSE 0 END) AS traces,
          COUNT(*) AS observations
        FROM events_full
        WHERE created_at >= {start: DateTime}
          AND created_at < {end: DateTime}
        GROUP BY project_id, CAST(created_at AS DATE)
      `,
      params: {
        start: convertDateToAnalyticsDateTime(params.start),
        end: convertDateToAnalyticsDateTime(params.end),
      },
      tags: { feature: "billing", type: "units", kind: "analytic" },
    }),
    queryDoris<{ project_id: string; date: string; scores: string }>({
      query: `
        SELECT
          project_id,
          CAST(created_at AS DATE) AS date,
          COUNT(*) AS scores
        FROM scores
        WHERE created_at >= {start: DateTime}
          AND created_at < {end: DateTime}
        GROUP BY project_id, CAST(created_at AS DATE)
      `,
      params: {
        start: convertDateToAnalyticsDateTime(params.start),
        end: convertDateToAnalyticsDateTime(params.end),
      },
      tags: { feature: "billing", type: "units", kind: "analytic" },
    }),
  ]);

  const counts = new Map<string, BillingUnitCountByProjectAndDay>();
  for (const row of eventRows) {
    const key = `${row.project_id}:${row.date}`;
    const traces = Number(row.traces);
    const observations = Number(row.observations);
    counts.set(key, {
      projectId: row.project_id,
      date: row.date,
      traces,
      observations,
      scores: 0,
      total: traces + observations,
    });
  }
  for (const row of scoreRows) {
    const key = `${row.project_id}:${row.date}`;
    const scores = Number(row.scores);
    const existing = counts.get(key) ?? {
      projectId: row.project_id,
      date: row.date,
      traces: 0,
      observations: 0,
      scores: 0,
      total: 0,
    };
    existing.scores = scores;
    existing.total += scores;
    counts.set(key, existing);
  }
  return [...counts.values()];
}
