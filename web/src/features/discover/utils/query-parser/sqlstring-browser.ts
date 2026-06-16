// @ts-nocheck
type Primitive = string | number | boolean | bigint | null | undefined | Date;

type RawSql = {
  __raw: true;
  value: string;
};

const RAW_FLAG = "__raw";

const escapeString = (value: string): string => {
  const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `'${escaped}'`;
};

const formatDate = (value: Date): string => {
  const pad = (input: number) => input.toString().padStart(2, "0");
  const year = value.getFullYear();
  const month = pad(value.getMonth() + 1);
  const day = pad(value.getDate());
  const hours = pad(value.getHours());
  const minutes = pad(value.getMinutes());
  const seconds = pad(value.getSeconds());

  return `'${year}-${month}-${day} ${hours}:${minutes}:${seconds}'`;
};

const escapePrimitive = (value: Primitive | RawSql): string => {
  if (isRaw(value)) {
    return value.value;
  }

  if (value === null || value === undefined) {
    return "NULL";
  }

  if (value instanceof Date) {
    return formatDate(value);
  }

  switch (typeof value) {
    case "number":
    case "bigint":
      return `${value}`;
    case "boolean":
      return value ? "1" : "0";
    default:
      return escapeString(String(value));
  }
};

const escapeIdentifier = (identifier: string | RawSql): string => {
  if (isRaw(identifier)) {
    return identifier.value;
  }

  return identifier
    .split(".")
    .map((part) => {
      if (part === "*") {
        return "*";
      }
      return `\`${part.replace(/`/g, "``")}\``;
    })
    .join(".");
};

const escapeValue = (value: any): string => {
  if (isRaw(value)) {
    return value.value;
  }

  if (Array.isArray(value)) {
    const list = value.map((item) => escapeValue(item));
    return `(${list.join(", ")})`;
  }

  if (value && typeof value === "object" && !(value instanceof Date)) {
    return escapeString(JSON.stringify(value));
  }

  return escapePrimitive(value as Primitive);
};

const isRaw = (value: unknown): value is RawSql =>
  Boolean(value && typeof value === "object" && RAW_FLAG in (value as any));

const format = (sql: string, values?: any[]): string => {
  if (!values || values.length === 0) {
    return sql;
  }

  let index = 0;

  return sql.replace(/\?\?|\?/g, (placeholder) => {
    if (index >= values.length) {
      return placeholder;
    }

    const value = values[index++];

    if (placeholder === "??") {
      if (Array.isArray(value)) {
        return value.map((v) => escapeIdentifier(v)).join(", ");
      }
      return escapeIdentifier(value);
    }

    return escapeValue(value);
  });
};

const raw = (value: string): RawSql => ({
  __raw: true,
  value,
});

const SqlString = {
  format,
  raw,
};

export default SqlString;
