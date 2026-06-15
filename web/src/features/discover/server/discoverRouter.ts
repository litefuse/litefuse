import { z } from "zod/v4";
import {
  createTRPCRouter,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";
import { dorisClient } from "@langfuse/shared/src/server";
import { isLangfuseDatabase, injectProjectIdFilter } from "./queryUtils";

function escapeIdentifier(value: string) {
  return value.replace(/`/g, "``");
}

export const discoverRouter = createTRPCRouter({
  databases: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
      }),
    )
    .query(async () => {
      const rows = await dorisClient({ database: "" }).query("SHOW DATABASES");
      return { rows };
    }),

  tables: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        database: z.string(),
      }),
    )
    .query(async ({ input }) => {
      const rows = await dorisClient({ database: input.database }).query(
        `SHOW TABLES FROM \`${escapeIdentifier(input.database)}\``,
      );
      return { rows };
    }),

  fields: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        database: z.string(),
        table: z.string(),
      }),
    )
    .query(async ({ input }) => {
      const rows = await dorisClient({ database: input.database }).query(
        `SHOW COLUMNS FROM \`${escapeIdentifier(input.database)}\`.\`${escapeIdentifier(input.table)}\``,
      );
      return { rows };
    }),

  indexes: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        database: z.string(),
        table: z.string(),
      }),
    )
    .query(async ({ input }) => {
      const rows = await dorisClient({ database: input.database }).query(
        `SHOW INDEXES FROM \`${escapeIdentifier(input.database)}\`.\`${escapeIdentifier(input.table)}\``,
      );
      return { rows };
    }),

  query: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        rawSql: z.string(),
        database: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const trimmed = input.rawSql.trim();
      const useMatch = trimmed.match(/^USE\s+`?([^`;]+)`?\s*;\s*/i);

      let database = input.database;
      let sql = trimmed;

      if (useMatch) {
        database = useMatch[1];
        sql = trimmed.slice(useMatch[0].length).trim();
      }

      const finalSql = isLangfuseDatabase(database)
        ? injectProjectIdFilter(sql, input.projectId)
        : sql;
      const client = database ? dorisClient({ database }) : dorisClient();
      const rows = (await client.query(finalSql)) as Record<string, unknown>[];

      // Normalize date values: DATE columns from mysql2 become Date objects with
      // time 00:00:00.000Z. When serialized to JSON, these become ISO strings like
      // "2026-04-03T00:00:00.000Z". For DATE columns (pure dates), convert to
      // "YYYY-MM-DD" format so that filtering with "=" works correctly.
      const normalizedRows = rows.map((row) => {
        const normalized: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          normalized[key] = normalizeDateValue(value);
        }
        return normalized;
      });

      return { rows: normalizedRows };
    }),
});

/**
 * Normalizes date values from mysql2 driver.
 * DATE columns are returned as JavaScript Date objects with time set to 00:00:00.000Z.
 * When serialized to JSON, these become ISO strings like "2026-04-03T00:00:00.000Z".
 * For DATE columns (pure dates with no time), convert to "YYYY-MM-DD" format instead.
 *
 * Also handles ISO strings that already represent pure dates (e.g., from mysql2
 * returning strings instead of Date objects in some configurations).
 */
function normalizeDateValue(value: unknown): unknown {
  // Handle Date objects
  if (value instanceof Date) {
    // Check if this is a pure date (time component is 00:00:00.000Z)
    if (
      value.getUTCHours() === 0 &&
      value.getUTCMinutes() === 0 &&
      value.getUTCSeconds() === 0 &&
      value.getUTCMilliseconds() === 0
    ) {
      // This is a DATE column - format as YYYY-MM-DD
      const year = value.getUTCFullYear();
      const month = String(value.getUTCMonth() + 1).padStart(2, "0");
      const day = String(value.getUTCDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
    // For datetime columns, keep the ISO string representation
    return value.toISOString();
  }

  // Handle ISO string values that represent pure dates
  // These might come from mysql2 returning strings for DATE columns
  if (typeof value === "string") {
    // Check if it's an ISO datetime string ending with 00:00:00.000Z (pure date)
    if (/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(value)) {
      // Extract and return just the date part
      return value.substring(0, 10); // "2026-04-03"
    }
  }

  return value;
}
