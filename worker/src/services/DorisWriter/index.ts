import {
  dorisClient,
  DorisClientType,
  formatDataForDoris,
  BlobStorageFileLogInsertType,
  EventRecordInsertType,
  getCurrentSpan,
  ObservationRecordInsertType,
  recordGauge,
  recordHistogram,
  recordIncrement,
  ScoreRecordInsertType,
  TraceRecordInsertType,
  DatasetRunItemRecordInsertType,
} from "@langfuse/shared/src/server";

import { env as sharedEnv } from "@langfuse/shared/src/env";
import { env as workerEnv } from "../../env";
import { logger } from "@langfuse/shared/src/server";
import { instrumentAsync } from "@langfuse/shared/src/server";
import { SpanKind } from "@opentelemetry/api";

export class DorisWriter {
  private static instance: DorisWriter | null = null;
  private static client: DorisClientType | null = null;
  batchSize: number;
  maxQueueSizeBytes: number;
  writeInterval: number;
  gaugeInterval: number;
  maxAttempts: number;
  queue: DorisQueue;
  queueSizeBytes: Map<TableName, number>;

  isIntervalFlushInProgress: boolean;
  intervalId: NodeJS.Timeout | null = null;
  gaugeIntervalId: NodeJS.Timeout | null = null;

  // Per-window add/flush counters drive the gauge log. Both reset to 0
  // each time the gauge tick emits, so each log line shows the rate over
  // exactly one interval.
  private addCounters = new Map<TableName, number>();
  private flushCounters = new Map<TableName, number>();

  private constructor() {
    this.batchSize = workerEnv.LITEFUSE_INGESTION_DORIS_WRITE_BATCH_SIZE;
    this.maxQueueSizeBytes =
      workerEnv.LITEFUSE_INGESTION_DORIS_MAX_QUEUE_SIZE_BYTES;
    this.writeInterval = workerEnv.LITEFUSE_INGESTION_DORIS_WRITE_INTERVAL_MS;
    this.gaugeInterval = workerEnv.LITEFUSE_INGESTION_DORIS_GAUGE_INTERVAL_MS;
    this.maxAttempts = sharedEnv.LITEFUSE_INGESTION_DORIS_MAX_ATTEMPTS;

    this.isIntervalFlushInProgress = false;

    this.queue = {
      [TableName.Traces]: [],
      [TableName.Scores]: [],
      [TableName.Observations]: [],
      [TableName.BlobStorageFileLog]: [],
      [TableName.DatasetRunItems]: [],
      [TableName.EventsFull]: [],
    };

    this.queueSizeBytes = new Map();

    this.start();
  }

  /**
   * Get the singleton instance of DorisWriter.
   * Client parameter is only used for testing.
   */
  public static getInstance(dorisClient?: DorisClientType) {
    if (dorisClient) {
      DorisWriter.client = dorisClient;
    }

    if (!DorisWriter.instance) {
      DorisWriter.instance = new DorisWriter();
    }

    return DorisWriter.instance;
  }

  private start() {
    logger.info(
      `Starting DorisWriter. Max interval: ${this.writeInterval} ms, Max batch size: ${this.batchSize}, Max queue size: ${this.maxQueueSizeBytes} bytes`,
    );

    this.intervalId = setInterval(() => {
      if (this.isIntervalFlushInProgress) return;

      const hasWork = Object.values(this.queue).some((q) => q.length > 0);
      if (!hasWork) return;

      this.isIntervalFlushInProgress = true;

      logger.info(
        "[DorisWriter] Flush interval elapsed, flushing all Doris queues...",
      );

      this.flushAll().finally(() => {
        this.isIntervalFlushInProgress = false;
      });
    }, this.writeInterval);

    // Periodic queue gauge — one log line per table per window, but
    // skip tables that are completely silent (q=0 and no add/flush in
    // the window) so an idle system stays quiet instead of emitting
    // 6 zero rows every tick. Format: `q=<depth> +<added> -<flushed>`.
    const gaugeWindowSec = Math.round(this.gaugeInterval / 1000);
    this.gaugeIntervalId = setInterval(() => {
      for (const t of Object.values(TableName)) {
        const len = this.queue[t]?.length ?? 0;
        const added = this.addCounters.get(t) ?? 0;
        const flushed = this.flushCounters.get(t) ?? 0;
        this.addCounters.set(t, 0);
        this.flushCounters.set(t, 0);
        if (len === 0 && added === 0 && flushed === 0) continue;
        logger.info(
          `[DorisWriter.gauge.${gaugeWindowSec}s] ${t.padEnd(22)} q=${String(len).padEnd(7)} +${String(added).padEnd(7)} -${flushed}`,
        );
      }
    }, this.gaugeInterval);
  }

  public async shutdown(): Promise<void> {
    logger.info("Shutting down DorisWriter...");

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.gaugeIntervalId) {
      clearInterval(this.gaugeIntervalId);
      this.gaugeIntervalId = null;
    }

    await this.flushAll(true);

    logger.info("DorisWriter shutdown complete.");
  }

  private async flushAll(fullQueue = false) {
    return instrumentAsync(
      {
        name: "write-to-doris",
        spanKind: SpanKind.CONSUMER,
      },
      async () => {
        recordIncrement("langfuse.queue.doris_writer.request");
        await Promise.all([
          this.flush(TableName.Traces, fullQueue),
          this.flush(TableName.Scores, fullQueue),
          this.flush(TableName.Observations, fullQueue),
          this.flush(TableName.BlobStorageFileLog, fullQueue),
          this.flush(TableName.DatasetRunItems, fullQueue),
          this.flush(TableName.EventsFull, fullQueue),
        ]).catch((err) => {
          logger.error("DorisWriter.flushAll", err);
        });
      },
    );
  }

  private async flush<T extends TableName>(tableName: T, fullQueue = false) {
    const entityQueue = this.queue[tableName];
    if (entityQueue.length === 0) return;

    logger.info(
      `[DorisWriter.flush] Flushing ${tableName}, queue length: ${entityQueue.length}, batch size: ${this.batchSize}`,
    );
    const queueItems = entityQueue.splice(
      0,
      fullQueue ? entityQueue.length : this.batchSize,
    );

    const flushedBytes = queueItems.reduce(
      (sum, item) => sum + item.estimatedSizeBytes,
      0,
    );
    this.queueSizeBytes.set(
      tableName,
      (this.queueSizeBytes.get(tableName) ?? 0) - flushedBytes,
    );

    // Log wait time
    queueItems.forEach((item) => {
      const waitTime = Date.now() - item.createdAt;
      recordHistogram("langfuse.queue.doris_writer.wait_time", waitTime, {
        unit: "milliseconds",
      });
    });

    const currentSpan = getCurrentSpan();
    if (currentSpan) {
      currentSpan.setAttributes({
        [`${tableName}-length`]: queueItems.length,
      });
    }

    try {
      const processingStartTime = Date.now();

      await this.writeToDoris({
        table: tableName,
        records: queueItems.map((item) => item.data),
      });

      // Log processing time
      recordHistogram(
        "langfuse.queue.doris_writer.processing_time",
        Date.now() - processingStartTime,
        {
          unit: "milliseconds",
        },
      );

      logger.info(
        `[DorisWriter.flush] Flushed ${queueItems.length} records to Doris ${tableName}. New queue length: ${entityQueue.length}`,
      );

      this.flushCounters.set(
        tableName,
        (this.flushCounters.get(tableName) ?? 0) + queueItems.length,
      );

      recordGauge("ingestion_doris_insert_queue_length", entityQueue.length, {
        unit: "records",
        entityType: tableName,
      });
    } catch (err) {
      logger.error(`DorisWriter.flush ${tableName}`, err);

      // Re-add the records to the queue with incremented attempts
      queueItems.forEach((item) => {
        if (item.attempts < this.maxAttempts) {
          entityQueue.push({
            ...item,
            attempts: item.attempts + 1,
          });
          this.queueSizeBytes.set(
            tableName,
            (this.queueSizeBytes.get(tableName) ?? 0) + item.estimatedSizeBytes,
          );
        } else {
          // TODO - Add to a dead letter queue in Redis rather than dropping
          recordIncrement("langfuse.queue.doris_writer.error");
          logger.error(
            `Max attempts reached for ${tableName} record. Dropping record.`,
            { item: item.data },
          );
        }
      });
    }
  }

  public addToQueue<T extends TableName>(
    tableName: T,
    data: RecordInsertType<T>,
  ) {
    const entityQueue = this.queue[tableName];
    const estimatedSizeBytes = Buffer.byteLength(JSON.stringify(data), "utf8");
    entityQueue.push({
      createdAt: Date.now(),
      attempts: 1,
      data,
      estimatedSizeBytes,
    });

    this.queueSizeBytes.set(
      tableName,
      (this.queueSizeBytes.get(tableName) ?? 0) + estimatedSizeBytes,
    );

    // Per-push detail at debug level. Bump LOG_LEVEL=debug to inspect each push.
    logger.debug(
      `[DorisWriter.addToQueue] ${tableName} length=${entityQueue.length}`,
    );

    this.addCounters.set(tableName, (this.addCounters.get(tableName) ?? 0) + 1);

    if (entityQueue.length >= this.batchSize) {
      logger.info(
        `[DorisWriter.addToQueue] ${tableName} hit batch size ${this.batchSize}, flushing`,
      );

      this.flush(tableName).catch((err: any) => {
        logger.error("DorisWriter.addToQueue flush", err);
      });
    }

    if ((this.queueSizeBytes.get(tableName) ?? 0) >= this.maxQueueSizeBytes) {
      logger.info(
        `[DorisWriter.addToQueue] ${tableName} hit max queue size ${this.maxQueueSizeBytes} bytes, flushing`,
      );

      this.flush(tableName).catch((err: any) => {
        logger.error("DorisWriter.addToQueue flush", err);
      });
    }
  }

  private async writeToDoris<T extends TableName>(params: {
    table: T;
    records: RecordInsertType<T>[];
  }): Promise<void> {
    const startTime = Date.now();

    // Format data for Doris compatibility
    const formattedRecords = formatDataForDoris(params.records, params.table);

    await (DorisWriter.client ?? dorisClient())
      .insert(params.table, formattedRecords, {
        format: "json",
        strip_outer_array: true,
        read_json_by_line: false,
        timeout: 600, // 10 minutes
      })
      .catch((err: any) => {
        logger.error(`DorisWriter.writeToDoris ${err}`);
        throw err;
      });

    logger.debug(`DorisWriter.writeToDoris: ${Date.now() - startTime} ms`);

    recordGauge("ingestion_doris_insert", params.records.length);
  }

  /**
   * Force flush all queues immediately - useful for testing
   */
  public async forceFlushAll(fullQueue = false): Promise<void> {
    await this.flushAll(fullQueue);
  }
}

export enum TableName {
  Traces = "traces",
  Scores = "scores",
  Observations = "observation_source",
  BlobStorageFileLog = "blob_storage_file_log",
  DatasetRunItems = "dataset_run_items_rmt",
  EventsFull = "events_full",
}

type RecordInsertType<T extends TableName> = T extends TableName.Scores
  ? ScoreRecordInsertType
  : T extends TableName.Observations
    ? ObservationRecordInsertType
    : T extends TableName.Traces
      ? TraceRecordInsertType
      : T extends TableName.BlobStorageFileLog
        ? BlobStorageFileLogInsertType
        : T extends TableName.DatasetRunItems
          ? DatasetRunItemRecordInsertType
          : T extends TableName.EventsFull
            ? EventRecordInsertType
            : never;

type DorisQueue = {
  [T in TableName]: DorisWriterQueueItem<T>[];
};

type DorisWriterQueueItem<T extends TableName> = {
  createdAt: number;
  attempts: number;
  data: RecordInsertType<T>;
  estimatedSizeBytes: number;
};
