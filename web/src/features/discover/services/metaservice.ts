// @ts-nocheck
/**
 * Discover metadata service — fetches schema metadata via tRPC.
 *
 * All functions are async and return row-major data directly.
 */
import { directApi } from "@/src/utils/api";
import { lastValueFrom, Observable } from "rxjs";

const escapeSqlLiteral = (value: string) => value.replace(/'/g, "''");

const normalizeColumnType = ({
  dataType,
  columnType,
}: {
  dataType?: string;
  columnType?: string;
}): string => {
  const source = (columnType || dataType || "").trim();
  if (!source) {
    return "";
  }

  const lower = source.toLowerCase();

  if (lower.startsWith("nullable(") && lower.endsWith(")")) {
    const inner = source.slice(9, -1);
    const normalizedInner = normalizeColumnType({
      dataType: inner,
      columnType: undefined,
    });
    return normalizedInner ? `Nullable(${normalizedInner})` : source;
  }

  if (lower.startsWith("map")) return source.replace(/^map/i, "Map");
  if (lower.startsWith("array")) return source.replace(/^array/i, "Array");
  if (lower.startsWith("json") || lower.startsWith("variant")) return "JSON";
  if (lower === "bool" || lower === "boolean" || lower.startsWith("tinyint(1)"))
    return "Bool";
  if (lower.startsWith("tinyint")) return "Int8";
  if (lower.startsWith("smallint")) return "Int16";
  if (lower.startsWith("mediumint")) return "Int32";
  if (
    lower.startsWith("bigint") ||
    lower.startsWith("int") ||
    lower.startsWith("integer")
  )
    return "Int64";
  if (
    lower.startsWith("float") ||
    lower.startsWith("double") ||
    lower.startsWith("real")
  )
    return "Float64";
  if (lower.startsWith("decimal") || lower.startsWith("numeric"))
    return "Float64";
  if (lower.startsWith("date")) return source.replace(/^date/i, "Date");
  if (lower.startsWith("timestamp") || lower.startsWith("datetime"))
    return "DateTime";
  if (lower.startsWith("enum")) return source.replace(/^enum/i, "Enum");
  if (lower.startsWith("uuid")) return "UUID";
  if (lower.startsWith("ipv4")) return "IPv4";
  if (lower.startsWith("ipv6")) return "IPv6";
  if (lower.startsWith("tuple")) return source.replace(/^tuple/i, "Tuple");
  if (lower.startsWith("struct")) return source.replace(/^struct/i, "Tuple");
  if (
    lower.startsWith("char") ||
    lower.startsWith("varchar") ||
    lower.startsWith("text") ||
    lower.startsWith("string")
  )
    return "String";

  return source;
};

export { normalizeColumnType };

// ---------------------------------------------------------------------------
// tRPC-based metadata fetchers
// ---------------------------------------------------------------------------

// These return Observables for backward compatibility with existing subscribe() callers.
// TODO: migrate callers to async/await and remove Observable wrappers.

function wrapAsync<T>(
  fn: () => Promise<T>,
): Observable<{ data: T; ok: boolean }> {
  return new Observable((subscriber) => {
    fn()
      .then((data) => {
        subscriber.next({ data, ok: true });
        subscriber.complete();
      })
      .catch((err) => {
        subscriber.error(err);
      });
  });
}

export function getDatabases(projectId: string) {
  return wrapAsync(() => directApi.discover.databases.query({ projectId }));
}

export function getTablesService({
  projectId,
  database,
}: {
  projectId: string;
  database: string;
}) {
  return wrapAsync(() =>
    directApi.discover.tables.query({ projectId, database }),
  );
}

export function getFieldsService({
  projectId,
  database,
  table,
}: {
  projectId: string;
  database: string;
  table: string;
}) {
  return wrapAsync(() =>
    directApi.discover.fields.query({ projectId, database, table }),
  );
}

export function getIndexesService({
  projectId,
  database,
  table,
}: {
  projectId: string;
  database: string;
  table: string;
}) {
  return wrapAsync(() =>
    directApi.discover.indexes.query({ projectId, database, table }),
  );
}

export async function getColumn({
  projectId,
  database,
  table,
  column,
}: {
  projectId: string;
  database: string;
  table: string;
  column: string;
}) {
  if (!database || !table || !column) return null;

  const query = `
SELECT
  COLUMN_NAME AS Field,
  DATA_TYPE AS DataType,
  COLUMN_TYPE AS ColumnType
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = '${escapeSqlLiteral(database)}'
  AND TABLE_NAME = '${escapeSqlLiteral(table)}'
  AND COLUMN_NAME = '${escapeSqlLiteral(column)}'
LIMIT 1;
`;

  try {
    const { rows } = await directApi.discover.query.mutate({
      projectId,
      rawSql: query,
    });

    if (!rows || rows.length === 0) return null;

    const row = rows[0] as Record<string, unknown>;
    const name = String(row.Field ?? row.COLUMN_NAME ?? "");
    if (!name) return null;

    const dataType = row.DataType != null ? String(row.DataType) : undefined;
    const columnType =
      row.ColumnType != null ? String(row.ColumnType) : undefined;

    return {
      name,
      dataType,
      columnType,
      normalizedType: normalizeColumnType({ dataType, columnType }),
    };
  } catch (error) {
    console.error("Failed to fetch column metadata", error);
    return null;
  }
}

export async function getInvertedIndexColumns({
  projectId,
  database,
  table,
}: {
  projectId: string;
  database: string;
  table: string;
}) {
  if (!database || !table) return [];

  try {
    const { rows } = await directApi.discover.query.mutate({
      projectId,
      rawSql: `SHOW INDEXES FROM \`${database}\`.\`${table}\``,
    });

    if (!rows || rows.length === 0) return [];

    const indexedColumns = new Set<string>();
    for (const row of rows as Record<string, unknown>[]) {
      const columnName = String(row.Column_name ?? row.COLUMN_NAME ?? "");
      const indexType = String(row.Index_type ?? row.INDEX_TYPE ?? "");
      if (columnName && indexType.toUpperCase().includes("INVERT")) {
        indexedColumns.add(columnName);
      }
    }

    return Array.from(indexedColumns);
  } catch (error) {
    console.error("Failed to fetch inverted index metadata", error);
    return [];
  }
}

export function getColumnFromFieldService() {
  // stub — not implemented
}
