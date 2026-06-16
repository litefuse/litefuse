/**
 * IIngestionWriter abstraction + Doris physical TableName enum.
 *
 * IngestionService accepts an IIngestionWriter via constructor instead of
 * referring to a concrete writer. The web request handler runs a
 * per-request RequestWriteBuffer (sync flush with Doris group_commit)
 * without IngestionService caring which it is.
 *
 * TableName enum is the Doris-physical-table contract shared by the writer
 * and IngestionService.
 */

import type {
  DatasetRunItemRecordInsertType,
  EventRecordInsertType,
  ScoreRecordInsertType,
} from "../repositories/definitions";

export enum TableName {
  // Traces / Observations stay in the enum but are NEVER written. They
  // serve as TypeScript discrimination markers for IngestionService
  // intermediate-merge records that get converted to EventsFull rows
  // before they ever hit Doris. The writer plumbing intentionally omits
  // them.
  Traces = "traces",
  Observations = "observation_source",
  Scores = "scores",
  EventsFull = "events_full",
  DatasetRunItems = "dataset_run_items_rmt",
}

export type WritableTableName = Exclude<
  TableName,
  TableName.Traces | TableName.Observations
>;

/**
 * Map from writable table to its row insert type. Used to make
 * `IIngestionWriter.addToQueue(table, record)` accept the right record
 * type per table.
 */
export type RecordInsertType<T extends WritableTableName> =
  T extends TableName.Scores
    ? ScoreRecordInsertType
    : T extends TableName.EventsFull
      ? EventRecordInsertType
      : T extends TableName.DatasetRunItems
        ? DatasetRunItemRecordInsertType
        : never;

/**
 * Minimal write contract that IngestionService depends on.
 * RequestWriteBuffer implements this; IngestionService never sees the
 * concrete type.
 */
export interface IIngestionWriter {
  addToQueue<T extends WritableTableName>(
    tableName: T,
    record: RecordInsertType<T>,
  ): void;
}
