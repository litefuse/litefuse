// @ts-nocheck
import {
  QueryTableDataParams,
  DataFilterType,
  SurroundingParams,
} from "types/type";

export function getQueryTableResultSQL(params: QueryTableDataParams) {
  const indexesStatement = params.indexes_statement;
  let statement = `SELECT * FROM \`${params.database}\`.\`${params.table}\` WHERE`;

  if (indexesStatement && params.search_type === "Search") {
    statement += ` (${indexesStatement}) AND`;
  }

  // wrap timeField in backticks
  statement += ` (\`${params.timeField}\` BETWEEN '${params.startDate}' AND '${params.endDate}') `;

  statement = params.data_filters.reduce((prev, curr) => {
    return addSqlFilter(prev, curr);
  }, statement);

  if (params.search_type === "SQL" && params.search_value) {
    statement = statement + ` AND ${params.search_value}`;
  }

  if (params.search_type === "Lucene" && params.lucene_where) {
    statement = statement + ` AND (${params.lucene_where})`;
  }

  // also wrap timeField in ORDER BY with backticks
  statement =
    statement +
    ` ORDER BY \`${params.timeField}\` DESC LIMIT ${+params.page_size} OFFSET ${(+params?.page - 1) * params.page_size} `;

  return statement;
}

export function getTopDataFieldSQL(
  params: QueryTableDataParams & { fieldName: string },
) {
  const indexesStatement = params.indexes_statement;
  // Only select the specific field needed for value distribution
  let statement = `SELECT \`${params.fieldName}\` FROM \`${params.database}\`.\`${params.table}\` WHERE`;

  if (indexesStatement && params.search_type === "Search") {
    statement += ` (${indexesStatement}) AND`;
  }

  // wrap timeField in backticks
  statement += ` (\`${params.timeField}\` BETWEEN '${params.startDate}' AND '${params.endDate}') `;

  statement = params.data_filters.reduce((prev, curr) => {
    return addSqlFilter(prev, curr);
  }, statement);

  if (params.search_type === "SQL" && params.search_value) {
    statement = statement + ` AND ${params.search_value}`;
  }

  if (params.search_type === "Lucene" && params.lucene_where) {
    statement = statement + ` AND (${params.lucene_where})`;
  }

  // also wrap timeField in ORDER BY with backticks
  statement =
    statement +
    ` ORDER BY \`${params.timeField}\` DESC LIMIT ${+params.page_size} OFFSET ${(+params?.page - 1) * params.page_size} `;

  return statement;
}

export function getQueryTableChartsSQL(params: QueryTableDataParams) {
  const indexes = params.indexes;
  let statement = `SELECT ${params.interval}_FLOOR(table_per_time.T,${params.interval_value}) as TT,sum(table_per_time.cnt) as \`sum(cnt)\` FROM (SELECT ${params.interval}_FLOOR(${params.timeField}) as T,count(*) as cnt FROM \`${params.database}\`.\`${params.table}\` WHERE`;
  if (indexes && params.search_type === "Search") {
    statement += ` (${indexes}) AND`;
  }
  statement += ` (\`${params.timeField}\` between '${params.startDate}' AND '${params.endDate}') `;
  if (params.data_filters.length > 0) {
    statement = params.data_filters.reduce((prev, curr) => {
      return addSqlFilter(prev, curr);
    }, statement);
  }
  if (params.search_type === "SQL" && params.search_value) {
    statement = statement + ` ` + `AND ${params.search_value}`;
  }

  if (params.search_type === "Lucene" && params.lucene_where) {
    statement = statement + ` AND (${params.lucene_where})`;
  }
  statement =
    statement +
    ` ` +
    `GROUP BY T ORDER BY T) as table_per_time GROUP BY TT ORDER BY TT`;

  return statement;
}

export function getQueryTableResultCountSQL(params: QueryTableDataParams) {
  const indexes = params.indexes;
  let statement = `SELECT SUM(table_per_time.cnt) AS total_count
        FROM (
          SELECT ${params.interval}_FLOOR(${params.timeField}) as T, COUNT(*) as cnt
          FROM \`${params.database}\`.\`${params.table}\`
          WHERE`;
  if (indexes && params.search_type === "Search") {
    statement += ` (${indexes}) AND`;
  }
  statement += ` (\`${params.timeField}\` between '${params.startDate}' AND '${params.endDate}')`;

  if (params.data_filters.length > 0) {
    statement = params.data_filters.reduce((prev, curr) => {
      return addSqlFilter(prev, curr);
    }, statement);
  }
  if (params.search_type === "SQL" && params.search_value) {
    statement = statement + ` ` + `AND ${params.search_value}`;
  }

  if (params.search_type === "Lucene" && params.lucene_where) {
    statement = statement + ` AND (${params.lucene_where})`;
  }
  statement = statement + ` ` + `GROUP BY T) AS table_per_time;`;
  return statement;
}

export function getSurroundingSQL(params: SurroundingParams) {
  let statement = `SELECT * FROM \`${params.database}\`.\`${params.table}\` WHERE`;
  statement += ` (\`${params.timeField}\` ${params.operator} '${params.time}')`;
  statement = params.data_filters.reduce((prev: any, curr: any) => {
    return addSqlFilter(prev, curr);
  }, statement);
  const orderSymbol = params.operator === "<" ? "DESC" : "ASC";
  statement =
    statement +
    ` ` +
    `ORDER BY \`${params.timeField}\` ${orderSymbol} LIMIT ${+params.pageSize}`;
  return statement;
}

export function getFilterSQL({
  fieldName,
  operator,
  value,
}: DataFilterType): string {
  const valueString = value.map((e) => {
    if (typeof e === "string") {
      return `'${e}'`;
    } else {
      return e;
    }
  });

  const transformedFieldName = transformFieldPath(fieldName);

  if (
    operator === "=" ||
    operator === "!=" ||
    operator === "like" ||
    operator === "not like" ||
    operator === "match_all" ||
    operator === "match_any" ||
    operator === "match_phrase" ||
    operator === "match_phrase_prefix"
  ) {
    return `${transformedFieldName} ${operator} ${valueString[0]}`;
  }

  if (operator === "is null" || operator === "is not null") {
    return `${transformedFieldName} ${operator}`;
  }

  if (operator === "between" || operator === "not between") {
    return `${transformedFieldName} ${operator} ${valueString[0]} AND ${valueString[1]}`;
  }

  if (operator === "in" || operator === "not in") {
    return `${transformedFieldName} ${operator} (${valueString})`;
  }

  return "";
}

export function addSqlFilter(
  sql: string,
  dataFilterValue: DataFilterType,
): string {
  let result = sql;
  if (!sql.toUpperCase().includes("WHERE")) {
    result += " WHERE";
  } else {
    result += " AND";
  }

  result += ` (${getFilterSQL(dataFilterValue)})`;

  return result;
}

export function transformFieldPath(fieldPath: string): string {
  const parts = fieldPath.split(".");
  return (
    parts[0] +
    parts
      .slice(1)
      .map((part) => `['${part}']`)
      .join("")
  );
}
