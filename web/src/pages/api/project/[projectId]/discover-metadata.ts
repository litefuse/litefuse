import { type NextApiRequest, type NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "@/src/server/auth";
import { isProjectMemberOrAdmin } from "@/src/server/utils/checkProjectMembershipOrAdmin";
import { dorisClient, logger } from "@langfuse/shared/src/server";

type MetadataAction = "databases" | "tables" | "fields" | "indexes";

function escapeIdentifier(value: string) {
  return value.replace(/`/g, "``");
}

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

  const { action, database, table } = req.body as {
    action?: MetadataAction;
    database?: string;
    table?: string;
  };

  if (!action) {
    return res.status(400).json({ message: "action is required" });
  }

  try {
    let rows: unknown[] = [];

    switch (action) {
      case "databases": {
        rows = await dorisClient({ database: "" }).query("SHOW DATABASES");
        break;
      }
      case "tables": {
        if (!database) {
          return res.status(400).json({ message: "database is required" });
        }
        rows = await dorisClient({ database }).query(
          `SHOW TABLES FROM \`${escapeIdentifier(database)}\``,
        );
        break;
      }
      case "fields": {
        if (!database || !table) {
          return res
            .status(400)
            .json({ message: "database and table are required" });
        }
        rows = await dorisClient({ database }).query(
          `SHOW COLUMNS FROM \`${escapeIdentifier(database)}\`.\`${escapeIdentifier(table)}\``,
        );
        break;
      }
      case "indexes": {
        if (!database || !table) {
          return res
            .status(400)
            .json({ message: "database and table are required" });
        }
        rows = await dorisClient({ database }).query(
          `SHOW INDEXES FROM \`${escapeIdentifier(database)}\`.\`${escapeIdentifier(table)}\``,
        );
        break;
      }
      default: {
        return res.status(400).json({ message: "Unsupported action" });
      }
    }

    return res.status(200).json({ rows });
  } catch (error) {
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
