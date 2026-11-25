import z from "zod/v4";
import { singleFilter } from "../../../interfaces/filters";
import { FilterCondition } from "../../../types";
import { isValidTableName } from "../../doris/schemaUtils";
import { logger } from "../../logger";
import { UiColumnMappings } from "../../../tableDefinitions";
import {
  StringFilter,
  DateTimeFilter,
  StringOptionsFilter,
  CategoryOptionsFilter,
  NumberFilter,
  ArrayOptionsFilter,
  BooleanFilter,
  NumberObjectFilter,
  StringObjectFilter,
  NullFilter,
} from "./doris-filter";
import { FilterList } from "../filter";

export class QueryBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryBuilderError";
  }
}

// This function ensures that the user only selects valid columns from the doris schema.
// The filter property in this column needs to be zod verified.
// User input for values (e.g. project_id = <value>) are sent to Doris as parameters to prevent SQL injection
export const createDorisFilterFromFilterState = (
  filter: FilterCondition[],
  columnMapping: UiColumnMappings,
) => {
  return filter
    .filter((frontEndFilter) => frontEndFilter.type !== "positionInTrace")
    .map((frontEndFilter) => {
      // checks if the column exists in the doris schema
      const column = matchAndVerifyTracesUiColumn(
        frontEndFilter,
        columnMapping,
      );

      switch (frontEndFilter.type) {
        case "string":
          return new StringFilter({
            table: column.tableName,
            field: column.select,
            operator: frontEndFilter.operator,
            value: frontEndFilter.value,
            tablePrefix: column.queryPrefix,
          });
        case "datetime":
          return new DateTimeFilter({
            table: column.tableName,
            field: column.select,
            operator: frontEndFilter.operator,
            value: frontEndFilter.value,
            tablePrefix: column.queryPrefix,
          });
        case "stringOptions":
          return new StringOptionsFilter({
            table: column.tableName,
            field: column.select,
            operator: frontEndFilter.operator,
            values: frontEndFilter.value,
            tablePrefix: column.queryPrefix,
          });
        case "categoryOptions":
          return new CategoryOptionsFilter({
            table: column.tableName,
            field: column.select,
            operator: frontEndFilter.operator,
            key: frontEndFilter.key,
            values: frontEndFilter.value,
            tablePrefix: column.queryPrefix,
          });
        case "number":
          return new NumberFilter({
            table: column.tableName,
            field: column.select,
            operator: frontEndFilter.operator,
            value: frontEndFilter.value,
            tablePrefix: column.queryPrefix,
            typeOverwrite: column.typeOverwrite,
          });
        case "arrayOptions":
          return new ArrayOptionsFilter({
            table: column.tableName,
            field: column.select,
            operator: frontEndFilter.operator,
            values: frontEndFilter.value,
            tablePrefix: column.queryPrefix,
          });
        case "boolean":
          return new BooleanFilter({
            table: column.tableName,
            field: column.select,
            value: frontEndFilter.value,
            operator: frontEndFilter.operator,
            tablePrefix: column.queryPrefix,
          });
        case "numberObject":
          return new NumberObjectFilter({
            table: column.tableName,
            field: column.select,
            key: frontEndFilter.key,
            operator: frontEndFilter.operator,
            value: frontEndFilter.value,
            tablePrefix: column.queryPrefix,
          });
        case "stringObject":
          return new StringObjectFilter({
            table: column.tableName,
            field: column.select,
            operator: frontEndFilter.operator,
            key: frontEndFilter.key,
            value: frontEndFilter.value,
            tablePrefix: column.queryPrefix,
          });
        case "null":
          return new NullFilter({
            table: column.tableName,
            field: column.select,
            operator: frontEndFilter.operator,
            tablePrefix: column.queryPrefix,
          });
        default:
          // eslint-disable-next-line no-case-declarations
          const exhaustiveCheck: never = frontEndFilter;
          logger.error(
            `Invalid filter type: ${JSON.stringify(exhaustiveCheck)}`,
          );
          throw new QueryBuilderError(`Invalid filter type`);
      }
    });
};

const matchAndVerifyTracesUiColumn = (
  filter: z.infer<typeof singleFilter>,
  uiTableDefinitions: UiColumnMappings,
) => {
  // tries to match the column name to the doris table name
  logger.debug(`Filter to match: ${JSON.stringify(filter)}`);
  const uiTable = uiTableDefinitions.find(
    (col) =>
      col.uiTableName === filter.column || col.uiTableId === filter.column, // matches on the NAME of the column in the UI.
  );

  if (!uiTable) {
    throw new QueryBuilderError(
      `Column ${filter.column} does not match a UI / Doris table mapping.`,
    );
  }

  if (!isValidTableName(uiTable.tableName)) {
    throw new QueryBuilderError(
      `Invalid doris table name: ${uiTable.tableName}`,
    );
  }

  return uiTable;
};

export function getDorisProjectIdDefaultFilter(
  projectId: string,
  opts: { tracesPrefix: string },
): {
  tracesFilter: FilterList;
  scoresFilter: FilterList;
  observationsFilter: FilterList;
} {
  return {
    tracesFilter: new FilterList([
      new StringFilter({
        table: "traces",
        field: "project_id",
        operator: "=",
        value: projectId,
        tablePrefix: opts.tracesPrefix,
      }),
    ]),
    scoresFilter: new FilterList([
      new StringFilter({
        table: "scores",
        field: "project_id",
        operator: "=",
        value: projectId,
        tablePrefix: "s",
      }),
    ]),
    observationsFilter: new FilterList([
      new StringFilter({
        table: "observations",
        field: "project_id",
        operator: "=",
        value: projectId,
        tablePrefix: "o",
      }),
    ]),
  };
}
