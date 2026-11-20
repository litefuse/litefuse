import { PassThrough, type Readable } from "node:stream";
import { ParquetWriter } from "@dsnp/parquetjs";
import {
  type BlobExportRow,
  type BlobExportTable,
  parquetRow,
  parquetSchema,
} from "./parquetSchema";

type ParquetRowGroupOptions = {
  maxRows: number;
  targetBytes: number;
};

export async function uploadParquetExport(
  table: BlobExportTable,
  readRows: (signal: AbortSignal) => AsyncIterable<BlobExportRow>,
  upload: (stream: Readable) => Promise<void>,
  rowGroups: ParquetRowGroupOptions,
) {
  const output = new PassThrough();
  const controller = new AbortController();
  const { signal } = controller;
  // An upload can fail before it starts consuming the stream.
  output.on("error", () => {});

  const producer = (async () => {
    const writer = await ParquetWriter.openStream(
      parquetSchema(table),
      // The writer only calls write/end but types their return values as fs.WriteStream.
      output as unknown as Parameters<typeof ParquetWriter.openStream>[1],
      {
        useDataPageV2: false,
        // parquetjs 1.8.8 writes incorrect offsets for multi-page row groups.
        pageIndex: false,
      },
    );
    let group: BlobExportRow[] = [];
    let groupBytes = 0;

    async function flush() {
      writer.setRowGroupSize(group.length);
      for (const row of group) {
        signal.throwIfAborted();
        await writer.appendRow(parquetRow(table, row));
      }
      group = [];
      groupBytes = 0;
    }

    for await (const row of readRows(signal)) {
      signal.throwIfAborted();
      const bytes = Object.values(row).reduce<number>(
        (size, value) =>
          size + (typeof value === "string" ? Buffer.byteLength(value) : 8),
        0,
      );
      if (group.length > 0 && groupBytes + bytes > rowGroups.targetBytes) {
        await flush();
      }
      group.push(row);
      groupBytes += bytes;
      if (
        group.length >= rowGroups.maxRows ||
        groupBytes >= rowGroups.targetBytes
      ) {
        await flush();
      }
    }
    if (group.length > 0) await flush();
    signal.throwIfAborted();
    await writer.close();
  })();
  const consumer = Promise.resolve().then(() => upload(output));

  try {
    await Promise.all([producer, consumer]);
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    controller.abort(cause);
    output.destroy(cause);
    await Promise.allSettled([producer, consumer]);
    throw error;
  }
}
