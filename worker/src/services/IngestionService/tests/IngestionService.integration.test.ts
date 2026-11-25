import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@langfuse/shared/src/db";
import {
  dorisClient,
  redis,
  createOrgProjectAndApiKey,
  createTrace,
  createTracesCh,
  queryDoris,
} from "@langfuse/shared/src/server";
import { DorisWriter } from "../../DorisWriter";
import { IngestionService } from "../../IngestionService";
import { ScoreSourceEnum } from "@langfuse/shared";
import { Cluster } from "ioredis";

let projectId = "";
const environment = "default";

// The legacy v3 trace/observation merge-and-write cases were removed with the
// OTel-only Doris ingestion; score events still go through IngestionService.
describe("Ingestion end-to-end tests", () => {
  let ingestionService: IngestionService;
  let dorisWriter: DorisWriter;

  beforeEach(async () => {
    if (!redis) throw new Error("Redis not initialized");
    ({ projectId } = await createOrgProjectAndApiKey());

    if (redis instanceof Cluster) {
      await Promise.all(redis.nodes("master").map((node) => node.flushall()));
    } else {
      await redis.flushall();
    }

    dorisWriter = DorisWriter.getInstance();

    ingestionService = new IngestionService(
      redis,
      prisma,
      dorisWriter,
      dorisClient(),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();

    // Reset singleton instance
    await dorisWriter.shutdown();

    (DorisWriter as any).instance = null;
  });

  it("should silently reject invalid scores while processing valid ones", async () => {
    const traceId = randomUUID();
    const validScoreId1 = randomUUID();
    const validScoreId2 = randomUUID();
    const invalidScoreId1 = randomUUID(); // Will have value out of range
    const invalidScoreId2 = randomUUID(); // Will use archived config

    // Create a trace first
    await createTracesCh([
      createTrace({
        id: traceId,
        project_id: projectId,
        name: "test-trace",
        environment,
      }),
    ]);

    // Create score configs
    const validScoreConfigId = randomUUID();
    const archivedScoreConfigId = randomUUID();

    await Promise.all([
      // Valid numeric config with range 0-100
      prisma.scoreConfig.create({
        data: {
          id: validScoreConfigId,
          dataType: "NUMERIC",
          name: "valid-config",
          minValue: 0,
          maxValue: 100,
          projectId,
        },
      }),
      // Archived config that should be rejected
      prisma.scoreConfig.create({
        data: {
          id: archivedScoreConfigId,
          dataType: "NUMERIC",
          name: "archived-config",
          isArchived: true,
          projectId,
        },
      }),
    ]);

    // Process all scores - invalid ones should be rejected silently
    // and valid ones should be processed
    await Promise.all([
      // Valid score 1
      ingestionService.processScoreEventList({
        projectId,
        entityId: validScoreId1,
        createdAtTimestamp: new Date(),
        scoreEventList: [
          {
            id: validScoreId1,
            type: "score-create",
            timestamp: new Date().toISOString(),
            body: {
              id: validScoreId1,
              dataType: "NUMERIC",
              name: "valid-config",
              value: 85.5, // Within range 0-100
              source: ScoreSourceEnum.API,
              traceId: traceId,
              environment,
              configId: validScoreConfigId,
            },
          },
        ],
      }),
      // One valid score, two invalid scores
      ingestionService.processScoreEventList({
        projectId,
        entityId: validScoreId2,
        createdAtTimestamp: new Date(),
        scoreEventList: [
          // invalid score 1
          {
            id: invalidScoreId1,
            type: "score-create",
            timestamp: new Date().toISOString(),
            body: {
              id: invalidScoreId1,
              dataType: "NUMERIC",
              configId: validScoreConfigId,
              name: "valid-config",
              traceId: traceId,
              source: ScoreSourceEnum.API,
              value: 150, // Outside range 0-100, should fail validation
              environment,
            },
          },
          // valid score 2
          {
            id: validScoreId2,
            type: "score-create",
            timestamp: new Date().toISOString(),
            body: {
              id: validScoreId2,
              dataType: "NUMERIC",
              configId: validScoreConfigId,
              name: "archived-config",
              traceId: traceId,
              source: ScoreSourceEnum.API,
              value: 50,
              environment,
            },
          },
          // invalid score 2
          {
            id: invalidScoreId2,
            type: "score-create",
            timestamp: new Date().toISOString(),
            body: {
              id: invalidScoreId2,
              dataType: "NUMERIC",
              configId: archivedScoreConfigId,
              name: "archived-config",
              traceId: traceId,
              source: ScoreSourceEnum.API,
              value: 50, // Valid value but config is archived
              environment,
            },
          },
        ],
      }),
    ]);

    await dorisWriter.flushAll(true);

    // Verify that valid scores were inserted
    const validScore1 = await getScoreRecord(validScoreId1);
    expect(validScore1).toBeDefined();
    expect(validScore1!.trace_id).toBe(traceId);
    expect(validScore1!.value).toBe(85.5);
    expect(validScore1!.config_id).toBe(validScoreConfigId);

    // Verify that invalid scores were silently rejected (not inserted)
    expect(await getScoreRecord(invalidScoreId1)).toBeUndefined();
    expect(await getScoreRecord(invalidScoreId2)).toBeUndefined();
  });
});

async function getScoreRecord(scoreId: string) {
  const rows = await queryDoris<{
    trace_id: string;
    value: number;
    config_id: string | null;
  }>({
    query: `SELECT trace_id, value, config_id FROM scores WHERE project_id = {projectId: String} AND id = {scoreId: String}`,
    params: { projectId, scoreId },
  });
  return rows[0];
}
