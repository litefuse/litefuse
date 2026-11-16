import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import { ParquetReader } from "@dsnp/parquetjs";
import { describe, expect, it, vi } from "vitest";
import { uploadParquetExport } from "../features/blobstorage/uploadParquetExport";

describe("Parquet blob storage encoding", () => {
  async function encode(rows: Record<string, unknown>[]) {
    const chunks: Buffer[] = [];
    await uploadParquetExport(
      "observations_v2",
      async function* () {
        yield* rows;
      },
      (stream) =>
        pipeline(
          stream,
          new Writable({
            write(chunk: Buffer, _encoding, callback) {
              chunks.push(chunk);
              callback();
            },
          }),
        ),
    );
    return ParquetReader.openBuffer(Buffer.concat(chunks));
  }

  it("writes a typed file with the same schema for an empty result", async () => {
    const empty = await encode([]);
    const start = new Date("2026-11-15T01:02:03.123Z");
    const populated = await encode([
      {
        id: "span",
        start_time: start,
        tags: '["",null,"test"]',
        metadata: '[{"nested.value":9007199254740993}]',
        total_cost: "-12345678901234567.890123456789",
      },
    ]);
    try {
      expect(Number(empty.getRowCount())).toBe(0);
      expect(empty.getSchema().fields).toEqual(populated.getSchema().fields);
      const row = await populated.getCursor().next();
      expect(row).toMatchObject({
        id: "span",
        start_time: start,
        tags: { list: [{ element: "" }, {}, { element: "test" }] },
        metadata: '{"nested.value":9007199254740993}',
        total_cost: Buffer.from("ffffffffd81be4cdb941364e91c67eeb", "hex"),
      });
      expect(populated.getSchema().fields.total_cost).toMatchObject({
        precision: 38,
        scale: 12,
      });
    } finally {
      await empty.close();
      await populated.close();
    }
  });

  it("propagates a failed upload and aborts the row source", async () => {
    const failure = new Error("upload failed");
    const started = Promise.withResolvers<void>();
    let closed = false;
    await expect(
      uploadParquetExport(
        "scores",
        async function* (signal) {
          try {
            yield { id: "score", project_id: "project", timestamp: new Date() };
            started.resolve();
            if (!signal.aborted) await once(signal, "abort");
            signal.throwIfAborted();
          } finally {
            closed = true;
          }
        },
        async (stream) => {
          for await (const _chunk of stream) {
            await started.promise;
            throw failure;
          }
        },
      ),
    ).rejects.toThrow("upload failed");
    expect(closed).toBe(true);
  });

  it("splits large payloads across row groups and preserves their order", async () => {
    const input = "x".repeat(3 * 1024 * 1024);
    const reader = await encode(
      ["one", "two", "three"].map((id) => ({
        id,
        input,
        start_time: new Date(),
      })),
    );
    try {
      expect(reader.metadata.row_groups).toHaveLength(2);
      const cursor = reader.getCursor(["id"]);
      for (const id of ["one", "two", "three"]) {
        expect(await cursor.next()).toEqual({ id });
      }
      expect(await cursor.next()).toBeNull();
    } finally {
      await reader.close();
    }
  });

  it("rejects the upload when the row source fails after emitting data", async () => {
    const failure = new Error("Doris stream failed");
    const upload = async (stream: AsyncIterable<Buffer>) => {
      for await (const chunk of stream) {
        expect(Buffer.isBuffer(chunk)).toBe(true);
      }
    };
    const uploadFinished = vi.fn();

    await expect(
      uploadParquetExport(
        "scores",
        async function* () {
          yield { id: "score", project_id: "project", timestamp: new Date() };
          throw failure;
        },
        (stream) => upload(stream).then(uploadFinished),
      ),
    ).rejects.toBe(failure);
    expect(uploadFinished).not.toHaveBeenCalled();
  });
});
