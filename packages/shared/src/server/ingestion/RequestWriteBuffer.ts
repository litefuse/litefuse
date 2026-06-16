/**
 * RequestWriteBuffer — the IIngestionWriter implementation used by the
 * web process for per-request writes to Doris.
 *
 * Lifecycle: one instance per HTTP ingestion request. IngestionService
 * accumulates records via `addToQueue(table, record)` during merge; at
 * the end of the request handler, `flushAll()` issues one Stream Load
 * per touched table (in parallel) with `group_commit: async_mode`. The
 * SDK ack returns once Doris has accepted the rows into its WAL; the
 * actual table commit happens asynchronously when the group-commit
 * window closes (controlled by `group_commit_interval_ms` /
 * `group_commit_data_bytes`).
 *
 * Why async_mode in the OTel-only Lightweight build:
 *   - v4 Python / v5 JS SDKs emit one OTel span = one HTTP request with
 *     all attributes inlined. There is no follow-up `*-update` event
 *     and no cross-request `(prior-row merge)` requirement for the
 *     same entity, so we no longer need "writes visible before ack" to
 *     keep multi-step protocols consistent.
 *   - SDK retries replay the same protobuf payload; Doris UNIQUE KEY
 *     `(project_id, span_id)` with MoW resolves duplicates by load
 *     order, so idempotency holds regardless of commit timing.
 *   - sync_mode + advisory_lock + low `group_commit_interval_ms` was a
 *     v3-protocol workaround for the create/update split race. The
 *     OTel-only route rejects pre-v4/v5 SDKs at the entrypoint, so
 *     that race can no longer reach this code path.
 *
 * Why not partial_columns: Doris currently disallows `group_commit` +
 * `partial_columns` together. The events_full Stream Load body carries
 * the full row; for OTel-only inputs this is always the complete row
 * synthesized from a single OTel span, so partial_columns would add
 * nothing.
 */

import type {
  EventRecordInsertType,
  ScoreRecordInsertType,
  DatasetRunItemRecordInsertType,
} from "../repositories/definitions";
import {
  IIngestionWriter,
  RecordInsertType,
  TableName,
  WritableTableName,
} from "./ingestionWriter";
import { formatDataForDoris } from "../doris/client";
import type { DorisClientType } from "../doris/client";
import { env } from "../../env";
import { instrumentAsync } from "../instrumentation";
import { logger } from "../logger";
import { SpanKind } from "@opentelemetry/api";

type Buckets = {
  [T in WritableTableName]: RecordInsertType<T>[];
};

export class RequestWriteBuffer implements IIngestionWriter {
  private buckets: Buckets;

  constructor(private readonly client: DorisClientType) {
    this.buckets = {
      [TableName.Scores]: [] as ScoreRecordInsertType[],
      [TableName.EventsFull]: [] as EventRecordInsertType[],
      [TableName.DatasetRunItems]: [] as DatasetRunItemRecordInsertType[],
    };
  }

  /**
   * IIngestionWriter.addToQueue — buffer the record for end-of-request
   * flush. Never throws; failures surface from flushAll().
   */
  addToQueue<T extends WritableTableName>(
    tableName: T,
    record: RecordInsertType<T>,
  ): void {
    // Cast is safe: by construction this.buckets[tableName] has the
    // matching element type for T.
    (this.buckets[tableName] as RecordInsertType<T>[]).push(record);
  }

  /**
   * Issue one Stream Load per touched table in parallel.
   *
   * Each table flush uses Doris `group_commit: async_mode`. The HTTP
   * call returns once the rows have been ack-ed into Doris's group-
   * commit WAL; the actual commit happens asynchronously when the
   * batch closes. On any pre-WAL failure this rejects; the request
   * handler is expected to translate the rejection to 5xx so the SDK
   * retries.
   *
   * Idempotency: all events_full / scores / dataset_run_items writes
   * are UNIQUE KEY upserts keyed on stable IDs from the SDK payload, so
   * a retried request that re-flushes the same rows is safe.
   */
  async flushAll(): Promise<void> {
    return instrumentAsync(
      { name: "request-write-buffer.flush", spanKind: SpanKind.CLIENT },
      async () => {
        await Promise.all([
          this.flushTable(TableName.EventsFull),
          this.flushTable(TableName.Scores),
          this.flushTable(TableName.DatasetRunItems),
        ]);
      },
    );
  }

  private async flushTable<T extends WritableTableName>(
    table: T,
  ): Promise<void> {
    if (this.buckets[table].length === 0) return;

    // Snapshot via splice so we can drain the bucket BEFORE the
    // Stream Load — repeated flush calls within one request (the
    // per-entity flushes under the advisory lock plus the final
    // flushAll) must not re-send the same rows. `records` holds the
    // snapshot; the bucket is empty after splice. On Stream Load
    // failure we push the rows back so the request can surface the
    // error and the SDK retry replays everything.
    const records = (this.buckets[table] as RecordInsertType<T>[]).splice(
      0,
    ) as RecordInsertType<T>[];
    const formatted = formatDataForDoris(records as any[], table);

    logger.debug(
      `[RequestWriteBuffer] flushing ${records.length} rows to ${table} (group_commit=async_mode)`,
    );

    try {
      await this.client.insert(table, formatted, {
        format: "json",
        strip_outer_array: true,
        read_json_by_line: false,
        timeout: 60,
        group_commit: "async_mode",
        // Per-load overrides for the Doris group-commit window. Setting
        // them on the Stream Load avoids `ALTER TABLE ... SET (...)`
        // migrations and lets ops re-tune by redeploying the web
        // process. See LITEFUSE_DORIS_GROUP_COMMIT_* in shared/env.ts
        // for default rationale.
        group_commit_interval_ms: env.LITEFUSE_DORIS_GROUP_COMMIT_INTERVAL_MS,
        group_commit_data_bytes: env.LITEFUSE_DORIS_GROUP_COMMIT_DATA_BYTES,
      });
    } catch (err) {
      (this.buckets[table] as RecordInsertType<T>[]).unshift(...records);
      logger.error(
        `[RequestWriteBuffer] flush failed for table=${table}, rows=${records.length}`,
        err,
      );
      throw err;
    }
  }
}
