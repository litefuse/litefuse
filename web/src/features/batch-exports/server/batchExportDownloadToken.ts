import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/src/env.mjs";
import { z } from "zod/v4";
import { logger } from "@langfuse/shared/src/server";

export type BatchExportDownloadTokenPayload = {
  batchExportId: string;
  projectId: string;
  expiresAt: string;
};

export type BatchExportDownloadTokenVerificationResult =
  | {
      ok: true;
      payload: BatchExportDownloadTokenPayload;
    }
  | {
      ok: false;
      reason: "invalid" | "expired";
    };

const BatchExportDownloadTokenPayloadSchema = z.object({
  batchExportId: z.string().min(1),
  projectId: z.string().min(1),
  expiresAt: z.iso.datetime(),
});

let hasWarnedAboutBatchExportTokenSecretFallback = false;

const deriveBatchExportDownloadTokenFallbackSecret = () =>
  createHash("sha256")
    .update(env.SALT)
    .update("batch-export-download-token:v1")
    .digest("hex");

const getBatchExportDownloadTokenSecret = () => {
  if (env.BATCH_EXPORT_DOWNLOAD_TOKEN_SECRET) {
    return env.BATCH_EXPORT_DOWNLOAD_TOKEN_SECRET;
  }

  if (
    env.NODE_ENV === "production" &&
    !hasWarnedAboutBatchExportTokenSecretFallback
  ) {
    hasWarnedAboutBatchExportTokenSecretFallback = true;
    logger.warn(
      "BATCH_EXPORT_DOWNLOAD_TOKEN_SECRET is not configured; falling back to a SALT-derived per-deployment secret. Configure an explicit secret to avoid key reuse across concerns.",
    );
  }

  return deriveBatchExportDownloadTokenFallbackSecret();
};

const signPayload = (payloadBase64: string) =>
  createHmac("sha256", getBatchExportDownloadTokenSecret())
    .update(payloadBase64)
    .digest("base64url");

export const createBatchExportDownloadToken = (
  payload: BatchExportDownloadTokenPayload,
) => {
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const signature = signPayload(payloadBase64);
  return `${payloadBase64}.${signature}`;
};

export const verifyBatchExportDownloadToken = (
  token: string,
): BatchExportDownloadTokenVerificationResult => {
  const [payloadBase64, signature] = token.split(".");

  if (!payloadBase64 || !signature) {
    return { ok: false, reason: "invalid" };
  }

  const expectedSignature = signPayload(payloadBase64);
  const providedSignature = Buffer.from(signature);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);

  if (
    providedSignature.length !== expectedSignatureBuffer.length ||
    !timingSafeEqual(providedSignature, expectedSignatureBuffer)
  ) {
    return { ok: false, reason: "invalid" };
  }

  try {
    const parsedPayload = BatchExportDownloadTokenPayloadSchema.safeParse(
      JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8")),
    );

    if (!parsedPayload.success) {
      return { ok: false, reason: "invalid" };
    }

    if (new Date(parsedPayload.data.expiresAt).getTime() <= Date.now()) {
      return { ok: false, reason: "expired" };
    }

    return { ok: true, payload: parsedPayload.data };
  } catch {
    return { ok: false, reason: "invalid" };
  }
};

export const createBatchExportDownloadPath = (
  projectId: string,
  token: string,
) =>
  `${env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/project/${projectId}/batch-export/download?token=${encodeURIComponent(token)}`;
