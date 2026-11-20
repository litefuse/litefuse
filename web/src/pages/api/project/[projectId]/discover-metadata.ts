import { type NextApiRequest, type NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/src/server/auth";
import { isProjectMemberOrAdmin } from "@/src/server/utils/checkProjectMembershipOrAdmin";
import { logger } from "@langfuse/shared/src/server";
import {
  discoverDatabases,
  DiscoverQueryError,
  discoverTableMetadata,
  discoverTables,
} from "@/src/features/discover/server/queryUtils";

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

  const authOptions = await getAuthOptions();
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user) {
    return res.status(401).json({ message: "Unauthenticated" });
  }
  if (!isProjectMemberOrAdmin(session.user, projectId)) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const { action, database, table } = req.body ?? {};

  try {
    let rows: unknown[] = [];

    switch (action) {
      case "databases": {
        rows = discoverDatabases();
        break;
      }
      case "tables": {
        if (typeof database !== "string" || !database) {
          return res.status(400).json({ message: "database is required" });
        }
        rows = await discoverTables(projectId, database);
        break;
      }
      case "fields":
      case "indexes": {
        if (
          typeof database !== "string" ||
          !database ||
          typeof table !== "string" ||
          !table
        ) {
          return res
            .status(400)
            .json({ message: "database and table are required" });
        }
        rows = await discoverTableMetadata(action, projectId, database, table);
        break;
      }
      default: {
        return res.status(400).json({ message: "Unsupported action" });
      }
    }

    return res.status(200).json({ rows });
  } catch (error) {
    if (error instanceof DiscoverQueryError) {
      return res
        .status(error.code === "FORBIDDEN" ? 403 : 400)
        .json({ message: error.message });
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error("discover-metadata failed", {
      action,
      database,
      table,
      error: message,
    });
    return res.status(500).json({
      message: message || "Failed to query Doris metadata",
    });
  }
}
