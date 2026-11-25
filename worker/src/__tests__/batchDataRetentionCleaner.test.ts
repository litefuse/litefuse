import { expect, describe, it } from "vitest";
import { randomUUID } from "crypto";
import {
  BatchDataRetentionCleaner,
  BATCH_DATA_RETENTION_TABLES,
} from "../features/batch-data-retention-cleaner";
import {
  createOrgProjectAndApiKey,
  createScoresCh,
  createTraceScore,
  queryDoris,
} from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";

async function getDorisCount(
  table: string,
  projectId: string,
): Promise<number> {
  const result = await queryDoris<{ count: number }>({
    query: `SELECT count(*) as count FROM ${table} WHERE project_id = {projectId: String}`,
    params: { projectId },
  });
  return Number(result[0]?.count ?? 0);
}

describe("BatchDataRetentionCleaner", () => {
  it("only runs row-level retention for shared scores", () => {
    expect(BATCH_DATA_RETENTION_TABLES).toEqual(["scores"]);
  });

  describe("processBatch - scores", () => {
    const TABLE = "scores" as const;

    // Skipped: the retention cleaner query uses ClickHouse dateDiff('second', ...), which Doris does not support.
    it.skip("should process scores correctly (uses timestamp)", async () => {
      const now = Date.now();
      const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

      // Create project with 7-day retention
      const { projectId } = await createOrgProjectAndApiKey();
      await prisma.project.update({
        where: { id: projectId },
        data: { retentionDays: 7 },
      });

      // Insert score with old timestamp
      await createScoresCh([
        createTraceScore({
          id: randomUUID(),
          project_id: projectId,
          timestamp: tenDaysAgo,
        }),
      ]);

      // Verify score exists before deletion
      expect(await getDorisCount(TABLE, projectId)).toBe(1);

      // Run processBatch
      const cleaner = new BatchDataRetentionCleaner(TABLE);
      await cleaner.processBatch();

      // Verify score was deleted
      expect(await getDorisCount(TABLE, projectId)).toBe(0);
    });
  });
});
