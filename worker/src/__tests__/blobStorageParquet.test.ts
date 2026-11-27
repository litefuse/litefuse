import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import { ParquetReader } from "@dsnp/parquetjs";
import { describe, expect, it, vi } from "vitest";
import { uploadParquetExport } from "../features/blobstorage/uploadParquetExport";
import type { BlobExportTable } from "../features/blobstorage/parquetSchema";

const defaultRowGroups = { maxRows: 10_000, targetBytes: 64 * 1024 * 1024 };

describe("Parquet blob storage encoding", () => {
  async function encodeFile(
    table: BlobExportTable,
    rows: Record<string, unknown>[],
    rowGroups = defaultRowGroups,
  ) {
    const chunks: Buffer[] = [];
    await uploadParquetExport(
      table,
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
      rowGroups,
    );
    return Buffer.concat(chunks);
  }

  async function encode(
    rows: Record<string, unknown>[],
    rowGroups = defaultRowGroups,
  ) {
    return ParquetReader.openBuffer(
      await encodeFile("observations_v2", rows, rowGroups),
    );
  }

  it.each([
    ["traces", ["input", "output", "metadata"]],
    [
      "observations",
      [
        "input",
        "output",
        "metadata",
        "model_parameters",
        "usage_details",
        "cost_details",
        "status_message",
      ],
    ],
    ["observations_v2", ["input", "output", "metadata", "status_message"]],
    ["scores", ["comment", "string_value"]],
  ] as const)(
    "omits large-text statistics in %s without changing the values",
    async (table, columns) => {
      const payload = "large text ".repeat(8192);
      const values = Object.fromEntries(
        columns.map((column) => [
          column,
          column === "metadata" ? `[${JSON.stringify(payload)}]` : payload,
        ]),
      );
      const time = new Date("2026-11-15T01:02:03.123Z");
      const bytes = await encodeFile(table, [
        {
          ...values,
          id: "id",
          project_id: "project",
          start_time: time,
          timestamp: time,
          session_id: "session",
        },
      ]);
      const reader = await ParquetReader.openBuffer(bytes);
      try {
        const metadata = reader.metadata.row_groups[0].columns;
        for (const column of columns) {
          expect(
            metadata.find(
              (c) => c.meta_data?.path_in_schema.join(".") === column,
            )?.meta_data?.statistics,
          ).toBeFalsy();
        }
        const timeColumn =
          table === "traces" || table === "scores" ? "timestamp" : "start_time";
        expect(
          metadata.find((c) => c.meta_data?.path_in_schema[0] === timeColumn)
            ?.meta_data?.statistics?.min_value,
        ).toBeTruthy();
        expect(
          metadata.find((c) => c.meta_data?.path_in_schema[0] === "id")
            ?.meta_data?.statistics?.min_value,
        ).toBe("id");
        if (table === "traces" || table === "observations_v2") {
          expect(
            metadata.find(
              (c) => c.meta_data?.path_in_schema[0] === "session_id",
            )?.meta_data?.statistics?.max_value,
          ).toBe("session");
        }
        expect(await reader.getCursor([...columns]).next()).toEqual(
          Object.fromEntries(
            columns.map((column) => [
              column,
              column === "metadata" ? JSON.stringify(payload) : payload,
            ]),
          ),
        );
      } finally {
        await reader.close();
      }
    },
  );

  it("keeps compressible payloads out of the footer and page statistics", async () => {
    const input = "x".repeat(1024 * 1024);
    const bytes = await encodeFile("observations_v2", [
      { id: "large", start_time: new Date(), input },
    ]);
    expect(bytes.length).toBeLessThan(input.length / 4);
    const reader = await ParquetReader.openBuffer(bytes);
    try {
      expect(await reader.getCursor(["input"]).next()).toEqual({ input });
    } finally {
      await reader.close();
    }
  });

  it("preserves signed decimals without emitting incorrectly ordered statistics", async () => {
    const values = [
      "-12345678901234567.890123456789",
      "-1",
      "0",
      "0.000000000001",
      "1",
      "12345678901234567.890123456789",
      null,
    ];
    const expected = [
      -12345678901234567890123456789n,
      -1000000000000n,
      0n,
      1n,
      1000000000000n,
      12345678901234567890123456789n,
      null,
    ];
    const reader = await encode(
      values.map((total_cost, i) => ({
        id: String(i),
        start_time: new Date(),
        total_cost,
      })),
    );
    try {
      const column = reader.metadata.row_groups[0].columns.find(
        (c) => c.meta_data?.path_in_schema[0] === "total_cost",
      );
      expect(column?.meta_data?.statistics).toBeFalsy();
      const cursor = reader.getCursor(["total_cost"]);
      for (const value of expected) {
        const row = await cursor.next();
        if (value === null) {
          expect(row?.total_cost).toBeNull();
        } else {
          const bytes = row!.total_cost as Buffer;
          const unsigned = BigInt(`0x${bytes.toString("hex")}`);
          expect(bytes[0] & 0x80 ? unsigned - (1n << 128n) : unsigned).toBe(
            value,
          );
        }
      }
      expect(await cursor.next()).toBeNull();
    } finally {
      await reader.close();
    }
  });

  it("writes a 10,000-row group across pages and flushes the remaining row", async () => {
    const start = new Date("2026-11-15T01:02:03.123Z");
    const rows = Array.from({ length: 10_001 }, (_, i) => ({
      id: String(i),
      start_time: start,
      session_id: i % 2 ? "session" : null,
      tags: i % 2 ? '["tag",null]' : "[]",
    }));
    const reader = await encode(rows);
    try {
      expect(
        reader.metadata.row_groups.map((group) => Number(group.num_rows)),
      ).toEqual([10_000, 1]);
      const cursor = reader.getCursor();
      for (let i = 0; i < rows.length; i++) {
        expect(await cursor.next()).toMatchObject(
          i % 2
            ? {
                id: String(i),
                session_id: "session",
                tags: { list: [{ element: "tag" }, { element: null }] },
              }
            : { id: String(i), session_id: null, tags: { list: null } },
        );
      }
      expect(await cursor.next()).toBeNull();
      for (const group of reader.metadata.row_groups) {
        for (const column of group.columns) {
          expect(column.column_index_offset).toBeFalsy();
          expect(column.offset_index_offset).toBeFalsy();
        }
      }
    } finally {
      await reader.close();
    }
  });

  it("accepts an oversized single row and resumes normal byte-limited grouping", async () => {
    const rows = ["small", "x".repeat(4096), "small"].map((input, i) => ({
      id: String(i),
      start_time: new Date(),
      input,
    }));
    const reader = await encode(rows, { maxRows: 100, targetBytes: 1024 });
    try {
      expect(
        reader.metadata.row_groups.map((group) => Number(group.num_rows)),
      ).toEqual([1, 1, 1]);
      const cursor = reader.getCursor(["id", "input"]);
      for (const { id, input } of rows)
        expect(await cursor.next()).toEqual({ id, input });
      expect(await cursor.next()).toBeNull();
    } finally {
      await reader.close();
    }
  });

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
        defaultRowGroups,
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
      { maxRows: 100, targetBytes: 8 * 1024 * 1024 },
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
        defaultRowGroups,
      ),
    ).rejects.toBe(failure);
    expect(uploadFinished).not.toHaveBeenCalled();
  });
});
