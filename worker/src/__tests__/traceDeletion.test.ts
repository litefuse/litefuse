import { expect, describe, it, beforeAll } from "vitest";
import {
  dorisClient,
  formatDataForDoris,
  createObservation,
  createObservationsCh,
  createOrgProjectAndApiKey,
  createTraceScore,
  createScoresCh,
  createTrace,
  createTracesCh,
  getBlobStorageByProjectId,
  getObservationsForTrace,
  getScoresForTraces,
  getTracesByIds,
  StorageService,
  StorageServiceFactory,
} from "@langfuse/shared/src/server";
import { randomUUID } from "crypto";
import { processDorisTraceDelete } from "../features/traces/processDorisTraceDelete";
import { env } from "../env";
import { prisma } from "@langfuse/shared/src/db";

describe("trace deletion", () => {
  let eventStorageService: StorageService;
  let mediaStorageService: StorageService;

  beforeAll(() => {
    eventStorageService = StorageServiceFactory.getInstance({
      accessKeyId: env.LITEFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID,
      secretAccessKey: env.LITEFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY,
      bucketName: env.LITEFUSE_S3_EVENT_UPLOAD_BUCKET,
      endpoint: env.LITEFUSE_S3_EVENT_UPLOAD_ENDPOINT,
      region: env.LITEFUSE_S3_EVENT_UPLOAD_REGION,
      forcePathStyle: env.LITEFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE === "true",
    });

    mediaStorageService = StorageServiceFactory.getInstance({
      accessKeyId: env.LITEFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID,
      secretAccessKey: env.LITEFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY,
      bucketName: String(env.LITEFUSE_S3_MEDIA_UPLOAD_BUCKET),
      endpoint: env.LITEFUSE_S3_MEDIA_UPLOAD_ENDPOINT,
      region: env.LITEFUSE_S3_MEDIA_UPLOAD_REGION,
      forcePathStyle: env.LITEFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE === "true",
    });
  });

  it("should delete all traces, observations, and scores from Clickhouse", async () => {
    // Setup
    const { projectId } = await createOrgProjectAndApiKey();

    const traceId = randomUUID();
    await createTracesCh([createTrace({ id: traceId, project_id: projectId })]);
    await createObservationsCh([
      createObservation({ trace_id: traceId, project_id: projectId }),
    ]);
    await createScoresCh([
      createTraceScore({ trace_id: traceId, project_id: projectId }),
    ]);

    // When
    await processDorisTraceDelete(projectId, [traceId]);

    // Then
    const traces = await getTracesByIds([traceId], projectId);
    expect(traces).toHaveLength(0);

    const observations = await getObservationsForTrace({
      traceId,
      projectId,
      includeIO: true,
    });
    expect(observations).toHaveLength(0);

    const scores = await getScoresForTraces({
      projectId,
      traceIds: [traceId],
    });
    expect(scores).toHaveLength(0);
  });

  it("should delete S3 media files for deleted traces", async () => {
    // Setup
    const { projectId } = await createOrgProjectAndApiKey();

    const traceId = randomUUID();
    const observationId = randomUUID();

    await createTracesCh([createTrace({ id: traceId, project_id: projectId })]);
    await createObservationsCh([
      createObservation({
        id: observationId,
        trace_id: traceId,
        project_id: projectId,
      }),
    ]);

    const fileType = "text/plain";
    const data = "Hello, world!";

    await Promise.all([
      mediaStorageService.uploadFile({
        fileName: `${projectId}/trace-${traceId}.txt`,
        fileType,
        data,
      }),
      mediaStorageService.uploadFile({
        fileName: `${projectId}/observation-${observationId}.txt`,
        fileType,
        data,
      }),
    ]);

    const traceMediaId = randomUUID();
    await prisma.media.create({
      data: {
        id: traceMediaId,
        sha256Hash: randomUUID(),
        projectId,
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3), // 3 days in the past
        bucketPath: `${projectId}/trace-${traceId}.txt`,
        bucketName: String(env.LITEFUSE_S3_MEDIA_UPLOAD_BUCKET),
        contentType: fileType,
        contentLength: 0,
      },
    });
    await prisma.traceMedia.create({
      data: {
        id: randomUUID(),
        projectId,
        traceId,
        mediaId: traceMediaId,
        field: "test",
      },
    });

    const observationMediaId = randomUUID();
    await prisma.media.create({
      data: {
        id: observationMediaId,
        sha256Hash: randomUUID(),
        projectId,
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3), // 3 days in the past
        bucketPath: `${projectId}/observation-${observationId}.txt`,
        bucketName: String(env.LITEFUSE_S3_MEDIA_UPLOAD_BUCKET),
        contentType: fileType,
        contentLength: 0,
      },
    });
    await prisma.observationMedia.create({
      data: {
        id: randomUUID(),
        projectId,
        observationId,
        traceId,
        mediaId: observationMediaId,
        field: "test",
      },
    });

    // When
    await processDorisTraceDelete(projectId, [traceId]);

    // Then
    const files = await mediaStorageService.listFiles(projectId);
    expect(files).toHaveLength(0);

    const media = await prisma.media.findMany({
      where: {
        projectId,
      },
    });
    expect(media).toHaveLength(0);

    // No need to check observationMedia and traceMedia as they have a foreign key to media table.
  });

  it("should NOT delete S3 media files for deleted traces if referenced by other entity", async () => {
    // Setup
    const { projectId } = await createOrgProjectAndApiKey();

    const traceId1 = randomUUID();
    const traceId2 = randomUUID();

    await createTracesCh([
      createTrace({ id: traceId1, project_id: projectId }),
      createTrace({ id: traceId2, project_id: projectId }),
    ]);

    const fileType = "text/plain";
    const data = "Hello, world!";

    await mediaStorageService.uploadFile({
      fileName: `${projectId}/trace-${traceId1}.txt`,
      fileType,
      data,
    });

    const traceMediaId = randomUUID();
    await prisma.media.create({
      data: {
        id: traceMediaId,
        sha256Hash: randomUUID(),
        projectId,
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3), // 3 days in the past
        bucketPath: `${projectId}/trace-${traceId1}.txt`,
        bucketName: String(env.LITEFUSE_S3_MEDIA_UPLOAD_BUCKET),
        contentType: fileType,
        contentLength: 0,
      },
    });
    // Create TWO references to media item
    await prisma.traceMedia.create({
      data: {
        id: randomUUID(),
        projectId,
        traceId: traceId1,
        mediaId: traceMediaId,
        field: "test",
      },
    });
    await prisma.traceMedia.create({
      data: {
        id: randomUUID(),
        projectId,
        traceId: traceId2,
        mediaId: traceMediaId,
        field: "test",
      },
    });

    // When
    await processDorisTraceDelete(projectId, [traceId1]);

    // Then
    const files = await mediaStorageService.listFiles(projectId);
    expect(files).toHaveLength(1);

    const media = await prisma.media.findMany({
      where: {
        projectId,
      },
    });
    expect(media).toHaveLength(1);

    const traceMedia = await prisma.traceMedia.findMany({
      where: {
        projectId,
      },
    });
    expect(traceMedia).toHaveLength(1);
  });

  it("should delete S3 event files for deleted traces", async () => {
    // Setup
    const { projectId } = await createOrgProjectAndApiKey();

    const traceId = randomUUID();
    const observationId = randomUUID();
    const scoreId = randomUUID();

    await createTracesCh([createTrace({ id: traceId, project_id: projectId })]);
    await createObservationsCh([
      createObservation({
        id: observationId,
        trace_id: traceId,
        project_id: projectId,
      }),
    ]);
    await createScoresCh([
      createTraceScore({
        id: scoreId,
        trace_id: traceId,
        project_id: projectId,
      }),
    ]);

    const fileType = "application/json";
    const data = JSON.stringify({ hello: "world" });

    await Promise.all([
      eventStorageService.uploadFile({
        fileName: `${projectId}/traces/${traceId}-trace.json`,
        fileType,
        data,
      }),
      eventStorageService.uploadFile({
        fileName: `${projectId}/observation/${traceId}-observation.json`,
        fileType,
        data,
      }),
      eventStorageService.uploadFile({
        fileName: `${projectId}/score/${traceId}-score.json`,
        fileType,
        data,
      }),
    ]);

    const now = Date.now();
    await dorisClient().streamLoad(
      "blob_storage_file_log",
      formatDataForDoris(
        [
          {
            id: randomUUID(),
            project_id: projectId,
            entity_type: "trace",
            entity_id: traceId,
            event_id: randomUUID(),
            bucket_name: env.LITEFUSE_S3_EVENT_UPLOAD_BUCKET,
            bucket_path: `${projectId}/traces/${traceId}-trace.json`,
            created_at: now,
            updated_at: now,
            event_ts: now,
            is_deleted: 0,
          },
          {
            id: randomUUID(),
            project_id: projectId,
            entity_type: "observation",
            entity_id: observationId,
            event_id: randomUUID(),
            bucket_name: env.LITEFUSE_S3_EVENT_UPLOAD_BUCKET,
            bucket_path: `${projectId}/observation/${traceId}-observation.json`,
            created_at: now,
            updated_at: now,
            event_ts: now,
            is_deleted: 0,
          },
          {
            id: randomUUID(),
            project_id: projectId,
            entity_type: "score",
            entity_id: scoreId,
            event_id: randomUUID(),
            bucket_name: env.LITEFUSE_S3_EVENT_UPLOAD_BUCKET,
            bucket_path: `${projectId}/score/${traceId}-score.json`,
            created_at: now,
            updated_at: now,
            event_ts: now,
            is_deleted: 0,
          },
        ],
        "blob_storage_file_log",
      ),
      {
        format: "json",
        strip_outer_array: true,
        read_json_by_line: false,
        max_filter_ratio: 0.1,
      },
    );

    // When
    await processDorisTraceDelete(projectId, [traceId]);

    // Then
    const eventLog = getBlobStorageByProjectId(projectId);
    for await (const _ of eventLog) {
      // Should never happen as the expect event log to be empty
      expect(true).toBe(false);
    }

    const files = await eventStorageService.listFiles(projectId);
    expect(files).toHaveLength(0);
  });
});
