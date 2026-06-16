import { pipeline } from "node:stream/promises";
import { type NextApiRequest, type NextApiResponse } from "next";
import { z } from "zod/v4";
import {
  BatchExportFileFormat,
  BatchExportQuerySchema,
  isBatchExportDownloadReadyStatus,
} from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
import { logger } from "@langfuse/shared/src/server";
import { createBatchExportFileStream } from "@/src/features/batch-exports/server/exportService";
import { verifyBatchExportDownloadToken } from "@/src/features/batch-exports/server/batchExportDownloadToken";

const DownloadQuerySchema = z.object({
  token: z.string().min(1),
});

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const { projectId } = req.query;
  if (typeof projectId !== "string" || !projectId) {
    return res.status(400).json({ message: "Invalid project ID" });
  }

  const queryParse = DownloadQuerySchema.safeParse(req.query);
  if (!queryParse.success) {
    return res.status(400).json({ message: "Invalid download token" });
  }

  const tokenVerification = verifyBatchExportDownloadToken(
    queryParse.data.token,
  );
  if (!tokenVerification.ok) {
    if (tokenVerification.reason === "expired") {
      return res.status(410).json({ message: "Download token expired" });
    }

    return res.status(401).json({ message: "Invalid download token" });
  }
  const tokenPayload = tokenVerification.payload;

  if (tokenPayload.projectId !== projectId) {
    return res.status(403).json({ message: "Download token project mismatch" });
  }

  const batchExport = await prisma.batchExport.findFirst({
    where: {
      id: tokenPayload.batchExportId,
      projectId,
    },
  });

  if (!batchExport) {
    return res.status(404).json({ message: "Batch export not found" });
  }

  if (batchExport.expiresAt && batchExport.expiresAt.getTime() <= Date.now()) {
    return res.status(410).json({ message: "Batch export expired" });
  }

  if (!isBatchExportDownloadReadyStatus(batchExport.status)) {
    return res.status(409).json({
      message: "Batch export is not available for download",
    });
  }

  const query = BatchExportQuerySchema.safeParse(batchExport.query);
  if (!query.success) {
    logger.error("Failed to parse batch export query for download", {
      batchExportId: batchExport.id,
      error: query.error.message,
    });
    return res.status(500).json({ message: "Invalid batch export query" });
  }

  const format = z
    .nativeEnum(BatchExportFileFormat)
    .safeParse(batchExport.format);
  if (!format.success) {
    return res.status(500).json({ message: "Invalid batch export format" });
  }

  try {
    const file = await createBatchExportFileStream({
      projectId,
      query: query.data,
      format: format.data,
      cutoffCreatedAt: batchExport.createdAt,
      fileBaseName: batchExport.name,
    });
    const abortDownload = () => {
      if (!file.stream.destroyed) {
        file.stream.destroy(
          new Error("Batch export download aborted by client"),
        );
      }
    };

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", file.fileType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${file.fileName}"`,
    );

    req.once("close", abortDownload);

    try {
      await pipeline(file.stream, res);
      await prisma.batchExport
        .update({
          where: {
            id: batchExport.id,
          },
          data: {
            finishedAt: new Date(),
          },
        })
        .catch(() => undefined);
    } finally {
      req.off("close", abortDownload);
    }
  } catch (error) {
    logger.error("Failed to stream batch export download", {
      batchExportId: batchExport.id,
      error,
    });

    if (!res.headersSent) {
      return res.status(500).json({ message: "Failed to stream batch export" });
    }

    res.destroy(error instanceof Error ? error : undefined);
  }
}
