// @ts-nocheck
import { getAutoInterval } from "../constants";
import dayjs from "dayjs";
import type { Dayjs, ManipulateType } from "dayjs";
import { flatten, orderBy, some } from "lodash-es";
import { nanoid } from "nanoid";
import { IntervalEnum } from "types/type";
import type { DiscoverCurrent, DataFilterType, AutoInterval } from "types/type";
import jsTokens from "js-tokens";
import localeData from "dayjs/plugin/localeData";
import { FieldType } from "@grafana/data";
import type { DataFrame } from "@grafana/data";
import utc from "dayjs/plugin/utc";
import { isIgnorableHighlightToken } from "./utils";
dayjs.extend(utc);
dayjs.extend(localeData);

export const OPERATORS: string[] = [
  "=",
  "!=",
  "in",
  "not in",
  "is null",
  "is not null",
  "like",
  "not like",
  "between",
  "not between",
  "match_any",
  "match_all",
  "match_phrase",
  "match_phrase_prefix",
];
export const SQL_OPERATORS: string[] = [
  "=",
  "!=",
  ">",
  "<",
  ">=",
  "<=",
  "LIKE",
  "IN",
  "AND",
  "OR",
  "BETWEEN",
];
export const TIME_FIELD_TYPES = [
  "DATETIME",
  "DATE",
  "DATETIMEV2",
  "DATAV2",
  "TIME",
];
export function isValidTimeFieldType(fieldType: string): boolean {
  // extract base field type (strip parentheses and their contents)
  const baseFieldType = fieldType.split("(")[0];
  return TIME_FIELD_TYPES.includes(baseFieldType);
}
export const CAN_SEARCH_FIELD_TYPE = ["STRING", "ARRAY", "NUMBER", "VARIANT"];
export const ENABLE_SEARCH_FIELD_TYPE = ["DATETIME", "TIMESTAMP", "TIME"];
export const getFieldType = (columnType: string | undefined) => {
  if (!columnType) {
    return "";
  }
  const currentColumnType = FIELD_TYPES.find((item) =>
    item.value.some((val) => columnType.toLocaleUpperCase().includes(val)),
  );
  return currentColumnType?.key;
};

export const DISCOVER_DEFAULT_STATUS: DiscoverCurrent = {
  catalog: "internal",
  database: "langfuse",
  table: "",
  cluster: "",
  timeField: "",
  date: [],
};

export function getInitialDiscoverDatabase(
  currentDatabase: string | undefined,
  options: Array<{ value: string }>,
) {
  if (
    currentDatabase &&
    options.some((option) => option.value === currentDatabase)
  ) {
    return currentDatabase;
  }

  return (
    options.find((option) => option.value.startsWith("litefuse_"))?.value ??
    options[0]?.value
  );
}

export enum SearchableEnum {
  ANY = "ANY",
  YES = "YES",
  NO = "NO",
}
export enum AggregatableEnum {
  ANY = "ANY",
  YES = "YES",
  NO = "NO",
}

export const SEARCHABLE = [
  {
    label: `Any`,
    value: SearchableEnum.ANY,
  },
  {
    label: "Yes",
    value: SearchableEnum.YES,
  },
  {
    label: "No",
    value: SearchableEnum.NO,
  },
];

export const AGGREGATABLE = [
  {
    label: `Any`,
    value: AggregatableEnum.ANY,
  },
  {
    label: "Yes",
    value: AggregatableEnum.YES,
  },
  {
    label: "No",
    value: AggregatableEnum.NO,
  },
];

export enum FieldTypeEnum {
  ANY = "ANY",
  STRING = "STRING",
  NUMBER = "NUMBER",
  DATE = "DATE",
}

export enum ParamsKeyEnum {
  sqlCatalog = "sqlCatalog",
  sqlDatabase = "sqlDatabase",
  startDate = "startDateRange",
  endDate = "endDateRange",
  sqlSearch = "sqlSearch",
  selectedTable = "selectedTable",
  dateInterval = "dateInterval",
  selectedField = "selectedField",
  dataFilter = "dataFilter",
  selectedTimeField = "selectedTimeField",
  sortedField = "sortedField",
  searchType = "searchType",
  selectedIndex = "selectedIndex",
  selectedCluster = "selectedCluster",
}

export function getFilterSQL({
  fieldName,
  operator,
  value,
}: DataFilterType): string {
  const valueString = value.map((e: any) => {
    if (typeof e === "string") {
      return `'${e}'`;
    } else {
      return e;
    }
  });

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
    return `\`${fieldName}\` ${operator} ${valueString[0]}`;
  }

  if (operator === "is null" || operator === "is not null") {
    return `\`${fieldName}\` ${operator}`;
  }

  if (operator === "between" || operator === "not between") {
    return `\`${fieldName}\` ${operator} ${valueString[0]} AND ${valueString[1]}`;
  }

  if (operator === "in" || operator === "not in") {
    return `\`${fieldName}\` ${operator} (${valueString})`;
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

function isWrappedInQuotes(inputString: string): boolean {
  const pattern = /(["'])(.*?)\1/;
  return pattern.test(inputString);
}

export function getIndexesStatement(
  indexes: any[],
  allField: any[],
  keywords: string,
) {
  let operator: "MATCH_ANY" | "MATCH_PHRASE" | "MATCH_PHRASE_PREFIX" | "=" =
    "MATCH_ANY";

  let searchValue = keywords.trim();

  if (!searchValue || !indexes) {
    return "";
  }

  if (isWrappedInQuotes(keywords)) {
    operator = "MATCH_PHRASE";
  } else {
    searchValue = `'${searchValue}'`;
  }
  const indexesNames = indexes.map((item) => item.columnName);
  return indexesNames.reduce((prevValue, currValue) => {
    const currentField = allField.find(
      (field) => `${field.value}` === currValue,
    );
    const currentFieldType = getFieldType(currentField.Type)?.toUpperCase();
    if (currentFieldType === "NUMBER") {
      operator = "=";
    }
    if (currentFieldType === "STRING" || currentFieldType === "ARRAY") {
      if (isWrappedInQuotes(keywords)) {
        operator = "MATCH_PHRASE";
      } else {
        operator = "MATCH_ANY";
      }
    }
    const canSearchField = CAN_SEARCH_FIELD_TYPE.includes(
      currentFieldType as string,
    );
    if (canSearchField) {
      if (prevValue) {
        return `${prevValue} OR \`${currValue}\` ${operator} ${searchValue}`;
      } else {
        return `\`${currValue}\` ${operator} ${searchValue}`;
      }
    }
    return prevValue;
  }, "");
}

export const DISCOVER_SHORTCUTS = [
  {
    key: nanoid(),
    text: `Last 5 Minutes`,
    label: `Last 5 Minutes`,
    range: (now: dayjs.Dayjs = dayjs()) => [
      now.add(-5, "minute").startOf("second"),
      now,
    ],
    format: "HH:mm",
    raw: {
      from: "now-5m",
      to: "now",
    },
    type: "minute",
    number: -5,
  },
  {
    key: nanoid(),
    text: `Last 15 Minutes`,
    label: `Last 15 Minutes`,
    raw: {
      from: "now-15m",
      to: "now",
    },
    range: (now: dayjs.Dayjs = dayjs()) => [
      now.add(-15, "minute").startOf("second"),
      now,
    ],
    format: "HH:mm",
    type: "minute",
    number: -15,
  },
  {
    key: nanoid(),
    text: `Last 1 Hour`,
    label: `Last 1 Hour`,
    raw: {
      from: "now-1h",
      to: "now",
    },
    range: (now: dayjs.Dayjs = dayjs()) => [
      now.add(-1, "hour").startOf("second"),
      now,
    ],
    format: "HH:mm",
    type: "hour",
    number: -1,
  },
  {
    key: nanoid(),
    text: `Last 1 Day`,
    label: `Last 1 Day`,
    raw: {
      from: "now-1d",
      to: "now",
    },
    range: (now: dayjs.Dayjs = dayjs()) => [
      now.add(-1, "day").startOf("second"),
      now,
    ],
    format: "HH:mm",
    type: "day",
    number: -1,
  },
  {
    key: nanoid(),
    text: `Last 7 Days`,
    label: `Last 1 Days`,
    raw: {
      from: "now-7d",
      to: "now",
    },
    range: (now: dayjs.Dayjs = dayjs()) => [
      now.add(-7, "day").startOf("second"),
      now,
    ],
    format: "HH:mm",
    type: "day",
    number: -7,
  },
  {
    key: nanoid(),
    text: `Last 1 Month`,
    label: `Last 1 Month`,
    raw: {
      from: "now-1M",
      to: "now",
    },
    range: (now: dayjs.Dayjs = dayjs()) => [
      now.add(-1, "month").startOf("second"),
      now,
    ],
    format: "HH:mm",
    type: "month",
    number: -1,
  },
  {
    key: nanoid(),
    text: `Last 3 Months`,
    label: `Last 3 Months`,
    raw: {
      from: "now-3M",
      to: "now",
    },
    range: (now: dayjs.Dayjs = dayjs()) => [
      now.add(-3, "month").startOf("second"),
      now,
    ],
    format: "HH:mm",
    type: "month",
    number: -3,
  },
  {
    key: nanoid(),
    text: `Last 1 Year`,
    label: `Last 1 Year`,
    raw: {
      from: "now-1y",
      to: "now",
    },
    range: (now: dayjs.Dayjs = dayjs()) => [
      now.add(-1, "year").startOf("second"),
      now,
    ],
    format: "HH:mm",
    type: "year",
    number: -1,
  },
];

export const SURROUNDING_LOGS_OPERATORS = [
  {
    label: "5",
    value: "5",
  },
  {
    label: "10",
    value: "10",
  },
];

export function getLatestTime(id: string) {
  if (!id) {
    return null;
  }
  const selectedItem = DISCOVER_SHORTCUTS.find((item) => item.key === id);
  return selectedItem?.range();
}

export const TIME_INTERVALS = [
  {
    value: "auto",
    label: `Auto`,
  },
  {
    value: "second",
    label: `Second`,
  },
  {
    value: "minute",
    label: `Minute`,
  },
  {
    value: "hour",
    label: `Hour`,
  },
  {
    value: "day",
    label: `Day`,
  },
  {
    value: "week",
    label: `Week`,
  },
  {
    value: "month",
    label: `Month`,
  },
  {
    value: "year",
    label: `Year`,
  },
];

export const PAGESIZE_OPTIONS = [10, 20, 50, 100, 200];

export const FIELD_TYPES = [
  {
    key: "STRING",
    value: ["VARCHAR", "STRING", "CHAR", "TEXT"],
    icon: "",
  },
  {
    key: "NUMBER",
    value: [
      "INT",
      "LARGEINT",
      "SMALLINT",
      "TINYINT",
      "DECIMAL",
      "BIGINT",
      "FLOAT",
      "DOUBLE",
    ],
    icon: "",
  },
  {
    key: "DATE",
    value: ["DATE", "DATETIME", "DATEV2", "DATETIMEV2"],
    icon: "",
  },
  {
    key: "JSONB",
    value: ["JSONB"],
    icon: "",
    complex: true,
  },
  {
    key: "ARRAY",
    value: ["ARRAY"],
    icon: "",
    complex: true,
  },
  {
    key: "BOOLEAN",
    value: ["BOOLEAN"],
    icon: "",
  },
  {
    key: "BITMAP",
    value: ["BITMAP"],
    icon: "",
    complex: true,
  },
  {
    key: "HLL",
    value: ["HLL"],
    icon: "",
    complex: true,
  },
  {
    key: "VARIANT",
    value: ["VARIANT"],
    icon: "",
    complex: true,
  },
  {
    key: "JSON",
    value: ["JSON"],
    icon: "",
    complex: true,
  },
];

export function encodeBase64(str: string) {
  return btoa(
    encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, p1) =>
      String.fromCharCode(parseInt("0x" + p1, 10)),
    ),
  );
}

export function decodeBase64(base64: string) {
  return decodeURIComponent(
    Array.from(atob(base64))
      .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join(""),
  );
}

export const isComplexType = (columnType: string | undefined) => {
  if (!columnType) {
    return false;
  }
  const currentColumnType = FIELD_TYPES.find((item) =>
    item.value.some((val) => columnType.toLocaleUpperCase().includes(val)),
  );
  if (currentColumnType) {
    return !!currentColumnType.complex;
  }
  return true;
};

export function formatDate(interval: ManipulateType) {
  let date_format = "YYYY-MM-DD HH:mm:ss";
  switch (interval) {
    case "year":
      date_format = "YYYY";
      break;
    case "month":
      date_format = "YYYY-MM";
      break;
    case "week":
      date_format = "YYYY-MM-DD";
      break;
    case "day":
      date_format = "YYYY-MM-DD";
      break;
    case "hour":
      date_format = "YYYY-MM-DD HH:mm:ss";
      break;
    case "minute":
      date_format = "YYYY-MM-DD HH:mm:ss";
      break;
    case "second":
    default:
      date_format = "YYYY-MM-DD HH:mm:ss";
      break;
  }
  return date_format;
}

export function resetDate(date: Dayjs, interval: ManipulateType) {
  let date_reset = date;
  switch (interval) {
    case "year":
      date_reset
        .set("month", 1)
        .set("date", 1)
        .set("hour", 0)
        .set("minute", 0)
        .set("second", 0);
      break;
    case "month":
      date_reset
        .set("date", 1)
        .set("hour", 0)
        .set("minute", 0)
        .set("second", 0);
      break;
    case "week":
      date_reset.set("hour", 0).set("minute", 0).set("second", 0);
      break;
    case "day":
      date_reset.set("hour", 0).set("minute", 0).set("second", 0);
      break;
    case "hour":
      date_reset.set("minute", 0).set("second", 0);
      break;
    case "minute":
      date_reset.set("second", 0);
      break;
    case "second":
    default:
      break;
  }
  return date_reset;
}

export function getDateRange(startDate: Dayjs, endDate: Dayjs, interval: any) {
  const DATE_FORMAT = formatDate(interval.interval_unit);
  if (
    dayjs(startDate, DATE_FORMAT).isSame(
      dayjs(endDate, DATE_FORMAT),
      interval.interval_unit,
    )
  ) {
    return [endDate];
  }
  let date: any = resetDate(startDate, interval.interval_unit);
  const formatStartDate = date.format(DATE_FORMAT);
  const dates = [formatStartDate];
  do {
    date = dayjs(date).add(interval.interval_value, interval.interval_unit);
    if (dayjs(date).isBefore(endDate)) {
      dates.push(date.format(DATE_FORMAT));
    }
  } while (dayjs(date).isBefore(endDate));
  return dates;
}

export function getChartsData(
  tableDataCharts: any[],
  currentDate: [Dayjs, Dayjs],
) {
  const selectInterval: AutoInterval = getAutoInterval(currentDate);
  const [startDate, endDate] = currentDate;
  const intervalUnit: any = selectInterval.interval_unit || IntervalEnum.Auto;
  const timeInterval: any =
    intervalUnit === IntervalEnum.Auto
      ? selectInterval
      : { interval_value: 1, interval_unit: intervalUnit };
  const dates = getDateRange(
    startDate as Dayjs,
    endDate as Dayjs,
    timeInterval,
  );
  const tableDataMap = new Map();
  const result: any[] = [];
  const DATE_FORMAT_FROM_INTERVAL = formatDate(timeInterval.interval_unit);

  tableDataCharts.forEach((e) => {
    const currentLocale = dayjs.locale();
    const date = dayjs
      .utc(e["TT"])
      .local()
      .locale(currentLocale)
      .format(DATE_FORMAT_FROM_INTERVAL);
    tableDataMap.set(date, e["sum(cnt)"]);
  });
  dates.forEach((date) => {
    const newDate = dayjs(date).format(DATE_FORMAT_FROM_INTERVAL);
    if (!tableDataMap.get(newDate)) {
      tableDataMap.set(newDate, null);
    }
  });

  tableDataMap.forEach((value, key) => {
    result.push({
      TT: key,
      ["sum(cnt)"]: value,
    });
  });
  return orderBy(result, ["TT"], ["asc"]);
}

function shouldParseVariantJsonString(value: string) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return false;
  }

  return (
    trimmedValue.startsWith("{") ||
    trimmedValue.startsWith("[") ||
    trimmedValue.startsWith('"') ||
    trimmedValue === "true" ||
    trimmedValue === "false" ||
    trimmedValue === "null" ||
    /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmedValue)
  );
}

function parseVariantFieldValue(value: unknown, _fieldName: string) {
  if (value == null || typeof value !== "string") {
    return value;
  }

  if (!shouldParseVariantJsonString(value)) {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function convertColumnToRow(frame: any): Array<Record<string, any>> {
  const fieldNames = frame.schema.fields.map((f: any) => f.name);
  const columns = frame.data.values;

  if (columns.length === 0) {
    return [];
  }

  const numRows = columns[0].length;
  const rows: Array<Record<string, any>> = [];

  for (let i = 0; i < numRows; i++) {
    const row: Record<string, any> = {};
    for (let j = 0; j < columns.length; j++) {
      row[fieldNames[j]] = columns[j][i];
      if (isValidTimeFieldType(frame.schema.fields[j].type.toUpperCase())) {
        // if it is a time field, convert to Dayjs object
        row[fieldNames[j]] = formatTimestampToDateTime(
          row[fieldNames[j]],
          frame.schema.fields[j].precision || 3,
        );
      }
      if (frame.schema.fields[j].type === "VARIANT") {
        row[fieldNames[j]] = parseVariantFieldValue(
          row[fieldNames[j]],
          fieldNames[j],
        );
      }
    }
    rows.push(row);
  }

  return rows;
}

// Determine type by querying Doris fields, independent of Grafana types
export function convertColumnToRowViaFieldsType(
  frame: any,
  fields: any,
): Array<Record<string, any>> {
  const fieldNames = frame.schema.fields.map((f: any) => f.name);
  const columns = frame.data.values;

  if (columns.length === 0) {
    return [];
  }

  const numRows = columns[0].length;
  const rows: Array<Record<string, any>> = [];

  for (let i = 0; i < numRows; i++) {
    const row: Record<string, any> = {};
    for (let j = 0; j < columns.length; j++) {
      row[fieldNames[j]] = columns[j][i];
      if (isValidTimeFieldType(frame.schema.fields[j].type.toUpperCase())) {
        // if it is a time field, convert to Dayjs object
        row[fieldNames[j]] = formatTimestampToDateTime(
          row[fieldNames[j]],
          frame.schema.fields[j].precision || 3,
        );
        // row[fieldNames[j]] = dayjs.utc(row[fieldNames[j]]).locale(currentLocale).format('YYYY-MM-DD HH:mm:ss.SSS');
      }
      const currentFieldInfo = fields.find(
        (item: any) => item.Field === frame.schema.fields[j].name,
      );
      // if VARIANT type, convert to JSON object
      if (
        currentFieldInfo &&
        currentFieldInfo.Type.toUpperCase() === "VARIANT"
      ) {
        row[fieldNames[j]] = parseVariantFieldValue(
          row[fieldNames[j]],
          fieldNames[j],
        );
      }
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Convert row-major data from tRPC to the table display format.
 * Formats time fields and parses VARIANT JSON values.
 */
export function convertRowsToTableData(
  rows: Record<string, unknown>[],
): Array<Record<string, any>> {
  return rows.map((row) => {
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value instanceof Date) {
        // Store as UTC string to match what Doris stores, so SQL comparisons
        // (e.g. surrounding logs WHERE timeField > '...') work correctly.
        // Display code calls formatTimestampToDateTime() separately which converts UTC→local.
        out[key] = dayjs.utc(value).format("YYYY-MM-DD HH:mm:ss.SSS");
      } else if (
        typeof value === "string" &&
        shouldParseVariantJsonString(value)
      ) {
        out[key] = parseVariantFieldValue(value, key);
      } else {
        out[key] = value;
      }
    }
    return out;
  });
}

/**
 * Convert row-major data with field type awareness (for sidebar top-data).
 */
export function convertRowsToTableDataViaFieldsType(
  rows: Record<string, unknown>[],
  fields: any[],
): Array<Record<string, any>> {
  return rows.map((row) => {
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      const fieldInfo = fields.find((f: any) => f.Field === key);
      if (value instanceof Date) {
        out[key] = formatTimestampToDateTime(value);
      } else if (
        fieldInfo &&
        fieldInfo.Type?.toUpperCase() === "VARIANT" &&
        typeof value === "string"
      ) {
        out[key] = parseVariantFieldValue(value, key);
      } else {
        out[key] = value;
      }
    }
    return out;
  });
}

// Format timestamp to DATETIME([number]) format
export function formatTimestampToDateTime(timestamp: any, precision = 3) {
  const currentLocale = dayjs.locale();
  // base format: YYYY-MM-DD HH:mm:ss
  let formatString = "YYYY-MM-DD HH:mm:ss";

  // append fractional seconds based on precision
  if (precision > 0) {
    formatString += `.${"S".repeat(precision)}`;
  }
  // convert timestamp and format
  return dayjs
    .utc(timestamp)
    .local()
    .locale(currentLocale)
    .format(formatString);
}

export function formatTracesResData(frame: any) {
  const { data } = frame;
  const traceDataFrame: DataFrame = {
    name: "Trace ID",
    refId: frame.schema.refId || "Trace ID",
    fields: frame.schema.fields.map((f: any, i: number) => ({
      name: f.name,
      type: f.type,
      values: data.values[i],
      typeInfo: f.typeInfo,
      config: {},
    })),
    length: data.values[0].length,
  };
  try {
    traceDataFrame.fields.forEach((f) => {
      if (f.name === "serviceTags" || f.name === "tags") {
        f.type = FieldType.other;
        f.values = f.values.map((item) => JSON.parse(item));
      }
    });
  } catch (err) {
    console.log("err:", err);
  }
  console.log("traceDataFrame", traceDataFrame);
  return traceDataFrame;
}

function getSearchTableData(tokenizeFields: any[], tableResult: any[]) {
  const result: any = [...tokenizeFields];
  tableResult.forEach((tableItem) => {
    result.forEach((token: any) => {
      token["searchValue"] = tableItem[token.columnName];
    });
  });
  return result;
}

function searchField(data: any[], searchString: string) {
  return some(data, (item) => item.columnName === searchString);
}

function parseKeywords(keyword: string) {
  if (
    keyword.length >= 2 &&
    keyword[0] === keyword[keyword.length - 1] &&
    (keyword[0] === `'` || keyword[0] === `"`)
  ) {
    keyword = keyword.substring(1, keyword.length - 1);
  }
  return keyword;
}

function highlightDelimiter(inputStr: string, delimiter: string) {
  const highlighted = inputStr.replace(
    new RegExp(`${delimiter}`, "g"),
    `<mark>${delimiter}</mark>`,
  );
  return highlighted;
}

function insertUnderscore(arr: string[]) {
  return arr.reduce((result: string[], item: string, index) => {
    result.push(item);
    if (index < arr.length - 1) {
      result.push("_");
    }
    return result;
  }, []);
}

function compare_ignore_quotes(s1: string, s2: string) {
  // strip double and single quotes
  const cleanS1 = s1.replace(/['"]/g, "");
  const cleanS2 = s2.replace(/['"]/g, "");
  // compare
  return cleanS1 === cleanS2;
}

type SearchResultItem = { [key: string]: any };
export function generateHighlightedResults(
  data: { search_value: string; indexes: string[] },
  result: SearchResultItem[],
) {
  const keyword: string = data.search_value || "";
  const searchTableData = getSearchTableData(data.indexes, result);

  const keywordsTokens: string[] = flatten(
    Array.from(jsTokens(keyword))
      .filter((item) => item.type !== "Punctuator")
      .map((item) => {
        let res = item.value.toLowerCase();
        return item.value.includes("_")
          ? item.value.split("_").map((str) => str.toLowerCase())
          : res;
      }),
  );

  const _sourceResult = result.map((item) => {
    let itemSource = "";

    for (const key in item) {
      let highlightValue: any = item[key];
      let itemValue: any = item[key];

      if (typeof highlightValue === "object") {
        highlightValue = JSON.stringify(highlightValue);
        itemValue = JSON.stringify(itemValue);
      }

      if (keyword && searchField(searchTableData, key)) {
        const strValue =
          typeof itemValue === "string" ? itemValue : itemValue + "";

        if (isWrappedInQuotes(keyword)) {
          const parsedKeyword = parseKeywords(keyword);
          if (parsedKeyword === strValue) {
            highlightValue = `<mark>${itemValue}</mark>`;
          } else if (strValue.includes(parsedKeyword)) {
            highlightValue = highlightDelimiter(strValue, parsedKeyword);
          }
        } else {
          const tokenizedAns = Array.from(jsTokens(strValue)).map(
            (item) => item.value,
          );
          let ans: string[] = [];

          if (tokenizedAns.includes(keyword)) {
            ans = tokenizedAns;
          } else {
            const ansWithUnderscore = flatten(
              tokenizedAns.map((item) => {
                if (item.includes("_")) {
                  return insertUnderscore(item.split("_"));
                }
                return item;
              }),
            );
            ans = ansWithUnderscore;
          }

          if (ans.length > 0) {
            highlightValue = ans.reduce((acc: string, curr: string) => {
              if (
                keywordsTokens
                  .filter((token) => !isIgnorableHighlightToken(token))
                  .find((token) =>
                    compare_ignore_quotes(token, curr.toLowerCase()),
                  ) ||
                compare_ignore_quotes(keyword.toLowerCase(), curr.toLowerCase())
              ) {
                return acc + `<mark>${curr}</mark>`;
              }
              return acc + curr;
            }, "");
          }
        }
      }

      itemSource += `<span class="field-key">${key}:</span>${highlightValue} `;
    }

    return {
      _original: item,
      _source: itemSource.trim(),
    };
  });

  return _sourceResult;
}
