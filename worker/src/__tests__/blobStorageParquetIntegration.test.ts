import { randomUUID } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ParquetReader } from "@dsnp/parquetjs";
import type { Job } from "bullmq";
import { expect, it } from "vitest";
import { prisma } from "@langfuse/shared/src/db";
import { env as sharedEnv } from "@langfuse/shared/src/env";
import { encrypt } from "@langfuse/shared/encryption";
import {
  buildSplitTableStatements,
  commandDoris,
  createOrgProjectAndApiKey,
  StorageServiceFactory,
  tableFor,
} from "@langfuse/shared/src/server";
import { env } from "../env";
import { handleBlobStorageIntegrationProjectJob } from "../features/blobstorage/handleBlobStorageIntegrationProjectJob";

it.skipIf(
  env.LITEFUSE_USE_AZURE_BLOB === "true" ||
    sharedEnv.LITEFUSE_USE_GOOGLE_CLOUD_STORAGE === "true",
)(
  "exports Parquet from Doris to S3 and advances the completed window",
  async () => {
    const bucketName = env.LITEFUSE_S3_EVENT_UPLOAD_BUCKET!;
    const endpoint = env.LITEFUSE_S3_EVENT_UPLOAD_ENDPOINT;
    const region = env.LITEFUSE_S3_EVENT_UPLOAD_REGION ?? "us-east-1";
    const accessKeyId = env.LITEFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID!;
    const secretAccessKey = env.LITEFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY!;
    const forcePathStyle =
      env.LITEFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true";
    const s3 = new S3Client({
      endpoint,
      region,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
    });
    const storage = StorageServiceFactory.getInstance({
      endpoint,
      region,
      bucketName,
      accessKeyId,
      secretAccessKey,
      forcePathStyle,
      useAzureBlob: false,
      useGoogleCloudStorage: false,
      awsSse: undefined,
      awsSseKmsKeyId: undefined,
    });
    const { projectId, orgId } = await createOrgProjectAndApiKey({
      projectId: `parquet_${randomUUID().replaceAll("-", "")}`,
    });
    const prefix = `tests/${projectId}/`;
    const spans = tableFor(projectId, "spans");
    const now = new Date();
    const windowEnd = new Date(now.getTime() - 30 * 60_000);
    const startTime = new Date(windowEnd.getTime() - 10_123);

    try {
      await commandDoris({
        query: buildSplitTableStatements({
          projectId,
          retentionDays: 7,
          replication: sharedEnv.DORIS_REPLICATION_NUM,
          storagePageSize: 65536,
        }).spans,
      });
      await commandDoris({
        query: `
        INSERT INTO ${spans}
          (trace_id, start_time, span_id, project_id, is_root, name, tags,
           metadata, usage_details, cost_details, total_cost)
        VALUES
          ('trace', {startTime: DateTime}, 'span', {projectId: String}, 1,
           'Parquet export', ARRAY('tag', ''), '{"request":{"source":"test"}}',
           MAP('input', CAST('9007199254740993' AS BIGINT)),
           MAP('total', CAST('0.000000000001' AS DECIMAL(38,12))),
           CAST('0.000000000001' AS DECIMAL(38,12)))
      `,
        params: { startTime, projectId },
      });
      await prisma.blobStorageIntegration.create({
        data: {
          projectId,
          bucketName: `missing-${randomUUID()}`,
          endpoint,
          region,
          prefix,
          accessKeyId,
          secretAccessKey: encrypt(secretAccessKey),
          forcePathStyle,
          fileType: "PARQUET",
          type: "S3",
          enabled: true,
          exportFrequency: "hourly",
          exportSource: "TRACES_OBSERVATIONS_EVENTS",
          lastSyncAt: new Date(startTime.getTime() - 1000),
        },
      });

      const job = {
        data: { timestamp: now, payload: { projectId } },
      } as Job;
      await expect(
        handleBlobStorageIntegrationProjectJob(job),
      ).rejects.toThrow();
      expect(
        await prisma.blobStorageIntegration.findUniqueOrThrow({
          where: { projectId },
        }),
      ).toMatchObject({
        lastSyncAt: new Date(startTime.getTime() - 1000),
        lastError: expect.any(String),
      });
      await prisma.blobStorageIntegration.update({
        where: { projectId },
        data: { bucketName },
      });
      await handleBlobStorageIntegrationProjectJob(job);

      const tables = ["observations", "observations_v2", "scores", "traces"];
      const timestamp = windowEnd.toISOString().replaceAll(":", "-");
      const files = await storage.listFiles(prefix);
      expect(files.map(({ file }) => file).sort()).toEqual(
        tables.map(
          (table) => `${prefix}${projectId}/${table}/${timestamp}.parquet`,
        ),
      );
      for (const table of tables) {
        const object = await s3.send(
          new GetObjectCommand({
            Bucket: bucketName,
            Key: `${prefix}${projectId}/${table}/${timestamp}.parquet`,
          }),
        );
        expect(object.ContentType).toBe("application/vnd.apache.parquet");
        const bytes = Buffer.from(await object.Body!.transformToByteArray());
        const reader = await ParquetReader.openBuffer(bytes);
        try {
          const cursor = reader.getCursor();
          if (table === "scores") {
            expect(Number(reader.getRowCount())).toBe(0);
            expect(reader.getSchema().fields).toHaveProperty("timestamp");
          } else {
            const row = await cursor.next();
            expect(row).toMatchObject({
              id: table === "traces" ? "trace" : "span",
              [table === "traces" ? "timestamp" : "start_time"]: startTime,
              metadata: '{"request.source":"test"}',
            });
            if (table === "observations") {
              expect(row).toMatchObject({
                usage_details: '{"input":"9007199254740993"}',
                cost_details: '{"total":"0.000000000001"}',
              });
            }
            if (table === "observations_v2") {
              expect(row).toMatchObject({
                tags: { list: [{ element: "tag" }, { element: "" }] },
                total_cost: Buffer.from(
                  "00000000000000000000000000000001",
                  "hex",
                ),
              });
              expect(reader.getSchema().fields.total_cost).toMatchObject({
                precision: 38,
                scale: 12,
              });
            }
          }
          expect(await cursor.next()).toBeNull();
        } finally {
          await reader.close();
        }
      }
      expect(
        await prisma.blobStorageIntegration.findUniqueOrThrow({
          where: { projectId },
        }),
      ).toMatchObject({ lastSyncAt: windowEnd, lastError: null });
      // A stale retry has no eligible window once the checkpoint is committed.
      await handleBlobStorageIntegrationProjectJob(job);
      expect(
        await prisma.blobStorageIntegration.findUniqueOrThrow({
          where: { projectId },
        }),
      ).toMatchObject({ lastSyncAt: windowEnd, lastError: null });

      for (const fileType of ["CSV", "JSON", "JSONL"] as const) {
        const textPrefix = `${prefix}${fileType}/`;
        await prisma.blobStorageIntegration.update({
          where: { projectId },
          data: {
            prefix: textPrefix,
            fileType,
            lastSyncAt: new Date(startTime.getTime() - 1000),
          },
        });
        await handleBlobStorageIntegrationProjectJob(job);
        const files = await storage.listFiles(
          `${textPrefix}${projectId}/observations_v2/`,
        );
        expect(files).toHaveLength(1);
        expect(files[0].file.endsWith(`.${fileType.toLowerCase()}`)).toBe(true);
        expect(await storage.download(files[0].file)).toContain(
          "Parquet export",
        );
      }
    } finally {
      s3.destroy();
      await commandDoris({ query: `DROP TABLE IF EXISTS ${spans}` });
      const files = await storage.listFiles(prefix);
      if (files.length)
        await storage.deleteFiles(files.map(({ file }) => file));
      await prisma.organization.delete({ where: { id: orgId } });
    }
  },
  60_000,
);
