import { type NextApiRequest, type NextApiResponse } from "next";
import { z } from "zod/v4";
import {
  cancelPgBossJob,
  deletePgBossJob,
  getPgBossAdminSnapshot,
  logger,
  retryPgBossJob,
  unschedulePgBossJob,
} from "@langfuse/shared/src/server";
import { AdminApiAuthService } from "@/src/server/adminApiAuth";

const PgBossAdminBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("retry"),
    queueName: z.string(),
    jobIds: z.array(z.uuid()).min(1),
  }),
  z.object({
    action: z.literal("cancel"),
    queueName: z.string(),
    jobIds: z.array(z.uuid()).min(1),
  }),
  z.object({
    action: z.literal("delete"),
    queueName: z.string(),
    jobIds: z.array(z.uuid()).min(1),
  }),
  z.object({
    action: z.literal("unschedule"),
    queueName: z.string(),
    key: z.string().min(1),
  }),
]);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  try {
    if (req.method !== "POST" && req.method !== "GET") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    if (
      !AdminApiAuthService.handleAdminAuth(req, res, {
        isAllowedOnLangfuseCloud: true,
      })
    ) {
      return;
    }

    if (req.method === "GET") {
      const snapshot = await getPgBossAdminSnapshot();
      return res.status(200).json(snapshot);
    }

    const body = PgBossAdminBody.safeParse(req.body);

    if (!body.success) {
      res.status(400).json({ error: body.error });
      return;
    }

    switch (body.data.action) {
      case "retry": {
        await retryPgBossJob(body.data.queueName, body.data.jobIds);
        return res.status(200).json({ message: "Retried jobs" });
      }
      case "cancel": {
        await cancelPgBossJob(body.data.queueName, body.data.jobIds);
        return res.status(200).json({ message: "Cancelled jobs" });
      }
      case "delete": {
        await deletePgBossJob(body.data.queueName, body.data.jobIds);
        return res.status(200).json({ message: "Deleted jobs" });
      }
      case "unschedule": {
        await unschedulePgBossJob(body.data.queueName, body.data.key);
        return res.status(200).json({ message: "Unscheduled job" });
      }
    }
  } catch (error) {
    logger.error("Failed to handle pg-boss admin request", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Internal Server Error",
    });
  }
}
