import { ParquetSchema } from "@dsnp/parquetjs";

const text = { type: "UTF8", optional: true, compression: "SNAPPY" } as const;
// Full string min/max values are repeated in uncompressed Parquet metadata.
const largeText = { ...text, statistics: false } as const;
const requiredText = { ...text, optional: false };
const timestamp = { ...text, type: "TIMESTAMP_MILLIS" } as const;
const promptVersion = { ...text, type: "INT32" } as const;
const boolean = { ...text, type: "BOOLEAN" } as const;
const tags = {
  type: "LIST",
  optional: true,
  fields: { list: { repeated: true, fields: { element: text } } },
} as const;
const cost = {
  ...text,
  type: "DECIMAL",
  typeLength: 16,
  precision: 38,
  scale: 12,
  // parquetjs compares DECIMAL buffers as unsigned bytes, reversing signed bounds.
  statistics: false,
} as const;

const fields = {
  traces: {
    id: text,
    timestamp: { ...timestamp, optional: false },
    name: text,
    environment: text,
    project_id: requiredText,
    metadata: largeText,
    user_id: text,
    session_id: text,
    release: text,
    version: text,
    public: boolean,
    bookmarked: boolean,
    tags,
    input: largeText,
    output: largeText,
  },
  observations: {
    id: requiredText,
    trace_id: text,
    project_id: requiredText,
    environment: text,
    type: text,
    parent_observation_id: text,
    start_time: { ...timestamp, optional: false },
    end_time: timestamp,
    name: text,
    metadata: largeText,
    level: text,
    status_message: largeText,
    version: text,
    input: largeText,
    output: largeText,
    provided_model_name: text,
    model_parameters: largeText,
    usage_details: largeText,
    cost_details: largeText,
    completion_start_time: timestamp,
    prompt_name: text,
    prompt_version: promptVersion,
  },
  observations_v2: {
    id: requiredText,
    trace_id: text,
    name: text,
    type: text,
    level: text,
    version: text,
    environment: text,
    user_id: text,
    session_id: text,
    tags,
    release: text,
    trace_name: text,
    total_cost: cost,
    latency: { ...text, type: "INT64" },
    input: largeText,
    output: largeText,
    metadata: largeText,
    start_time: { ...timestamp, optional: false },
    end_time: timestamp,
    model: text,
    prompt_name: text,
    prompt_version: promptVersion,
    status_message: largeText,
    parent_observation_id: text,
    event_version: text,
  },
  scores: {
    id: text,
    timestamp: { ...timestamp, optional: false },
    project_id: requiredText,
    environment: text,
    trace_id: text,
    observation_id: text,
    name: text,
    value: { ...text, type: "FLOAT" },
    source: text,
    comment: largeText,
    data_type: text,
    string_value: largeText,
  },
} as const;

export type BlobExportTable = keyof typeof fields;
export type BlobExportRow = Record<string, unknown>;

export function parquetSchema(table: BlobExportTable) {
  return new ParquetSchema(fields[table]);
}

export function parquetRow(table: BlobExportTable, row: BlobExportRow) {
  return Object.fromEntries(
    Object.entries(fields[table]).map(([column, field]) => {
      const value = row[column];
      if (value == null) {
        if (!field.optional)
          throw new Error(`Missing Parquet column ${column}`);
        return [column, null];
      }

      const converted = convertField(column, field.type, value);
      if (converted === undefined) {
        throw new Error(`Invalid value for Parquet column ${column}`);
      }
      return [column, converted];
    }),
  );
}

function convertField(column: string, type: string, value: unknown) {
  switch (type) {
    case "UTF8":
      if (typeof value !== "string") return;
      if (column !== "metadata") return value;
      // The query wraps the JSON in an array so its original bytes survive the cast.
      if (value.startsWith("[") && value.endsWith("]"))
        return value.slice(1, -1);
      return;
    case "LIST": {
      if (typeof value !== "string") return;
      const elements: unknown = JSON.parse(value);
      if (
        Array.isArray(elements) &&
        elements.every(
          (element) => element === null || typeof element === "string",
        )
      ) {
        return {
          list: elements.map((element) =>
            element === null ? {} : { element },
          ),
        };
      }
      return;
    }
    case "TIMESTAMP_MILLIS": {
      const time =
        value instanceof Date
          ? value
          : typeof value === "string"
            ? new Date(value.replace(" ", "T") + "Z")
            : undefined;
      if (time && Number.isFinite(time.getTime())) return time;
      return;
    }
    case "BOOLEAN":
      if (value === true || value === 1 || value === "1") return true;
      if (value === false || value === 0 || value === "0") return false;
      return;
    case "INT32":
      if (typeof value === "number" && Number.isInteger(value)) return value;
      return;
    case "INT64":
      if (typeof value === "number" && Number.isSafeInteger(value))
        return value;
      if (typeof value === "string" && /^-?\d+$/.test(value))
        return BigInt(value);
      return;
    case "FLOAT":
      if (typeof value === "number") return value;
      return;
    case "DECIMAL": {
      if (typeof value !== "string") return;
      const match = /^(-?)(\d{1,26})(?:\.(\d{1,12}))?$/.exec(value);
      if (!match) return;
      const [, sign, integral, fraction = ""] = match;
      const scaled = BigInt(sign + integral + fraction.padEnd(12, "0"));
      const hex = BigInt.asUintN(128, scaled).toString(16).padStart(32, "0");
      return Buffer.from(hex, "hex");
    }
  }
}
