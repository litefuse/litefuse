/**
 * Test for verifying row_limit works correctly in Doris backend
 *
 * Run with:
 *   pnpm test -- --testPathPatterns="queryBuilder-doris-row-limit" --testNamePattern="row_limit"
 */

import { QueryBuilder } from "../../features/query/server/queryBuilder";
import {
  createObservation,
  createObservationsCh,
  createTrace,
  createTracesCh,
  queryDoris,
  tableFor,
} from "@langfuse/shared/src/server";
import { randomUUID } from "crypto";

const PROJECT_ID = `row_limit_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

describe("QueryBuilder Doris row_limit", () => {
  beforeAll(async () => {
    const traceNames = [
      "chat/completion",
      "embedding/create",
      "image/generate",
      "audio/transcribe",
      "moderation/check",
      "text/edit",
      "text/search",
      "file/upload",
      "file/download",
      "video/generate",
    ];

    const baseTime = new Date("2026-03-15T12:00:00.000Z");
    const traces = [];
    const observations = [];
    let obsCount = 0;

    for (let i = 0; i < 30; i++) {
      const timestamp = baseTime.getTime() + i * 3600000;
      const traceId = `trace-${String(i).padStart(3, "0")}`;
      traces.push(
        createTrace({
          id: traceId,
          name: traceNames[i % traceNames.length],
          project_id: PROJECT_ID,
          timestamp,
          environment: "development",
          created_at: timestamp,
          updated_at: timestamp,
          event_ts: timestamp,
        }),
      );

      const numObs = (i % 3) + 1;
      for (let j = 0; j < numObs; j++) {
        const startTime = timestamp + j * 1000;
        const endTime = startTime + 100 + j * 50;
        observations.push(
          createObservation({
            id: `obs-${String(obsCount).padStart(4, "0")}`,
            trace_id: traceId,
            name: `observation-${j}`,
            project_id: PROJECT_ID,
            start_time: startTime,
            end_time: endTime,
            environment: "development",
            created_at: startTime,
            updated_at: startTime,
            event_ts: startTime,
            total_cost: Math.random() * 0.5,
            type: "GENERATION",
          }),
        );
        obsCount++;
      }
    }

    await createTracesCh(traces);
    await createObservationsCh(observations);
  }, 60000);

  it("should apply LIMIT clause with row_limit = 5", async () => {
    const query = {
      view: "traces" as const,
      dimensions: [{ field: "name" }],
      metrics: [{ measure: "totalCost", aggregation: "sum" as const }],
      filters: [],
      rawSqlFilter: null,
      timeDimension: null,
      fromTimestamp: "2026-03-01T00:00:00.000Z",
      toTimestamp: "2026-04-01T00:00:00.000Z",
      orderBy: null,
      chartConfig: {
        type: "VERTICAL_BAR" as const,
        row_limit: 5,
      },
    };

    const queryBuilder = new QueryBuilder(query.chartConfig, "v1");
    const { query: sql, parameters } = await queryBuilder.build(
      query,
      PROJECT_ID,
      false,
    );

    const rows = await queryDoris({ query: sql, params: parameters });
    expect(rows.length).toBeLessThanOrEqual(5);
  }, 60000);

  it("should apply LIMIT clause with row_limit = 10", async () => {
    const query = {
      view: "traces" as const,
      dimensions: [{ field: "name" }],
      metrics: [{ measure: "totalCost", aggregation: "sum" as const }],
      filters: [],
      rawSqlFilter: null,
      timeDimension: null,
      fromTimestamp: "2026-03-01T00:00:00.000Z",
      toTimestamp: "2026-04-01T00:00:00.000Z",
      orderBy: null,
      chartConfig: {
        type: "VERTICAL_BAR" as const,
        row_limit: 10,
      },
    };

    const queryBuilder = new QueryBuilder(query.chartConfig, "v1");
    const { query: sql, parameters } = await queryBuilder.build(
      query,
      PROJECT_ID,
      false,
    );

    const rows = await queryDoris({ query: sql, params: parameters });
    expect(rows.length).toBeLessThanOrEqual(10);
  }, 60000);

  it("should apply raw SQL LIMIT correctly", async () => {
    const rows = await queryDoris({
      query: `
        SELECT name, count(*) as cnt
        FROM ${tableFor(PROJECT_ID, "traces_scalar")}
        WHERE start_time >= '2026-03-01 00:00:00.000' AND start_time < '2026-04-01 00:00:00.000'
        GROUP BY name
        LIMIT 5
      `,
    });

    expect(rows.length).toBeLessThanOrEqual(5);
  }, 60000);
});
