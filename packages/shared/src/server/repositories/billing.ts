import { convertDateToAnalyticsDateTime } from "./analytics";
import { queryDoris } from "./doris";

export type BillingUnitCountByProjectAndDay = {
  projectId: string;
  date: string;
  traces: number;
  observations: number;
  scores: number;
  total: number;
};

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
