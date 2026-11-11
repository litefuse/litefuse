/**
 * POST /api/project/[projectId]/discover-query
 *
 * Executes SQL queries against Apache Doris on behalf of the Discover feature.
 * Returns results in Grafana column-major frame format so the existing
 * discover service layer (services/discover.ts, utils/data.ts) can work
 * without modification.
 *
 * Request body:
 *   { queries: Array<{ refId: string; rawSql: string; format: string; datasource?: any }> }
 *
 * Response body (mirrors Grafana /api/ds/query response):
 *   { results: { [refId]: { frames: [{ schema: { fields: [{name, type}] }, data: { values: [[...]] } }] } } }
 */

import { type NextApiRequest, type NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/src/server/auth";
import { isProjectMemberOrAdmin } from "@/src/server/utils/checkProjectMembershipOrAdmin";
import { dorisClient, logger } from "@langfuse/shared/src/server";
import { z } from "zod/v4";
import { prepareDiscoverRead } from "@/src/features/discover/server/readQuery";
import { DiscoverQueryError } from "@/src/features/discover/server/queryUtils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const queryBatch = z.object({
  queries: z.array(z.object({ refId: z.string(), rawSql: z.string() })).min(1),
});

interface GrafanaField {
  name: string;
  type: string;
}

interface GrafanaFrame {
  schema: { fields: GrafanaField[] };
  data: { values: unknown[][] };
}

interface QueryResult {
  frames: GrafanaFrame[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferGrafanaType(value: unknown): string {
  if (value instanceof Date) return "time";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

/**
 * Converts a row-major result set (array of row objects) into the Grafana
 * column-major frame format expected by the discover layer.
 */
function rowsToGrafanaFrame(rows: Record<string, unknown>[]): GrafanaFrame {
  if (rows.length === 0) {
    return { schema: { fields: [] }, data: { values: [] } };
  }

  const columnNames = Object.keys(rows[0]);

  // Build column arrays
  const columnArrays: unknown[][] = columnNames.map(() => []);
  for (const row of rows) {
    for (let i = 0; i < columnNames.length; i++) {
      columnArrays[i].push(row[columnNames[i]] ?? null);
    }
  }

  // Infer the Grafana type from the first non-null value in each column
  const fields: GrafanaField[] = columnNames.map((name, i) => {
    const firstNonNull = columnArrays[i].find(
      (v) => v !== null && v !== undefined,
    );
    return { name, type: inferGrafanaType(firstNonNull) };
  });

  return {
    schema: { fields },
    data: { values: columnArrays },
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const { projectId } = req.query;
  if (typeof projectId !== "string" || !projectId) {
    return res.status(400).json({ message: "Invalid project ID" });
  }

  // ---- Auth: must be a logged-in user who is a member of the project --------
  const authOptions = await getAuthOptions();
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user) {
    return res.status(401).json({ message: "Unauthenticated" });
  }
  if (!isProjectMemberOrAdmin(session.user, projectId)) {
    return res.status(403).json({ message: "Forbidden" });
  }
  // --------------------------------------------------------------------------

  const batch = queryBatch.safeParse(req.body);
  if (!batch.success) {
    return res.status(400).json({ message: "Invalid queries array" });
  }

  const resultEntries = await Promise.all(
    batch.data.queries.map(
      async ({ refId, rawSql }): Promise<[string, QueryResult]> => {
        try {
          const { database, sql } = prepareDiscoverRead(projectId, rawSql);
          const rows = await dorisClient({ database }).query(sql);
          return [refId, { frames: [rowsToGrafanaFrame(rows)] }];
        } catch (error) {
          if (!(error instanceof DiscoverQueryError)) {
            logger.error("discover-query: SQL execution failed", {
              refId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return [refId, { frames: [] }];
        }
      },
    ),
  );

  const results = Object.fromEntries(resultEntries);
  return res.status(200).json({ results });
}
