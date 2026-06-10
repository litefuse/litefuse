import { type z } from "zod/v4";
import { convertDateToAnalyticsDateTime } from "@langfuse/shared/src/server";
import type {
  QueryType,
  ViewDeclarationType,
  metricAggregations,
  granularities,
  ViewVersion,
  views,
} from "../types";
import {
  query as queryModel,
  getValidAggregationsForMeasureType,
} from "../types";
import { getViewDeclaration } from "@/src/features/query/dataModel";
import { viewDeclarationsDoris } from "@/src/features/query/dataModelDoris";
import {
  FilterList,
  createDorisFilterFromFilterState,
  createFilterFromFilterState,
  type Filter,
} from "@langfuse/shared/src/server";
import { InvalidRequestError } from "@langfuse/shared";
import { NULL_IF_EMPTY_RE } from "./nullIfEmptyFilter";

type AppliedDimensionType = {
  table: string;
  sql: string;
  alias?: string;
  relationTable?: string;
  aggregationFunction?: string;
  explodeArray?: boolean;
  pairExpand?: { valuesSql: string; valueAlias: string };
};

type AppliedMetricType = {
  sql: string;
  aggregation: z.infer<typeof metricAggregations>;
  alias?: string;
  relationTable?: string;
  aggs?: Record<string, string>;
  measureName: string; // Original measure name for lookups
  requiresDimension?: string;
};

type RawSqlPart = { query: string; params: Record<string, unknown> };

type MappedFilters = {
  whereFilters: Filter[];
  whereRawParts: RawSqlPart[];
};

export class QueryBuilder {
  private chartConfig?: { bins?: number; row_limit?: number };
  private version: ViewVersion;

  constructor(
    chartConfig?: { bins?: number; row_limit?: number },
    version: ViewVersion = "v1",
  ) {
    this.chartConfig = chartConfig;
    this.version = version;
  }

  private translateAggregation(metric: AppliedMetricType): string {
    switch (metric.aggregation) {
      case "sum":
        return `sum(${metric.alias || metric.sql})`;
      case "avg":
        return `avg(${metric.alias || metric.sql})`;
      case "count":
        return `count(${metric.alias || metric.sql})`;
      case "max":
        return `max(${metric.alias || metric.sql})`;
      case "min":
        return `min(${metric.alias || metric.sql})`;
      case "p50":
        return `quantile(0.5)(${metric.alias || metric.sql})`;
      case "p75":
        return `quantile(0.75)(${metric.alias || metric.sql})`;
      case "p90":
        return `quantile(0.9)(${metric.alias || metric.sql})`;
      case "p95":
        return `quantile(0.95)(${metric.alias || metric.sql})`;
      case "p99":
        return `quantile(0.99)(${metric.alias || metric.sql})`;
      case "histogram":
        // Get histogram bins from chart config, fallback to 10
        const bins = this.chartConfig?.bins ?? 10;
        return `histogram(${bins})(toFloat64(${metric.alias || metric.sql}))`;
      case "uniq":
        return `uniq(${metric.alias || metric.sql})`;
      default:
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const exhaustiveCheck: never = metric.aggregation;
        throw new InvalidRequestError(
          `Invalid aggregation: ${metric.aggregation}`,
        );
    }
  }

  private translateAggregationDoris(metric: AppliedMetricType): string {
    // For histogram, we need to use the raw metric value (not aggregated)
    // because histogram function requires a data series, not a single aggregated value
    const metricValue = metric.alias || metric.sql;

    switch (metric.aggregation) {
      case "sum":
        return `COALESCE(sum(${metricValue}), 0)`;
      case "avg":
        return `avg(${metricValue})`;
      case "count":
        return `count(${metricValue})`;
      case "max":
        return `max(${metricValue})`;
      case "min":
        return `min(${metricValue})`;
      case "p50":
        return `percentile_approx(${metricValue}, 0.5)`;
      case "p75":
        return `percentile_approx(${metricValue}, 0.75)`;
      case "p90":
        return `percentile_approx(${metricValue}, 0.9)`;
      case "p95":
        return `percentile_approx(${metricValue}, 0.95)`;
      case "p99":
        return `percentile_approx(${metricValue}, 0.99)`;
      case "histogram":
        const bins = this.chartConfig?.bins ?? 10;
        return `histogram(cast(${metricValue} as double), ${bins})`;
      case "uniq":
        return `count(distinct ${metricValue})`;
      default:
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const exhaustiveCheck: never = metric.aggregation;
        throw new InvalidRequestError(
          `Invalid aggregation: ${metric.aggregation}`,
        );
    }
  }

  private getViewDeclaration(
    viewName: z.infer<typeof views>,
  ): ViewDeclarationType {
    return getViewDeclaration(viewName, this.version);
  }

  private getViewDeclarationForDoris(
    viewName: z.infer<typeof views>,
  ): ViewDeclarationType {
    if (!(viewName in viewDeclarationsDoris)) {
      throw new InvalidRequestError(
        `Invalid view for Doris. Must be one of ${Object.keys(viewDeclarationsDoris)}`,
      );
    }
    return viewDeclarationsDoris[viewName];
  }

  private mapDimensions(
    dimensions: Array<{ field: string }>,
    view: ViewDeclarationType,
  ): AppliedDimensionType[] {
    return dimensions.map((dimension) => {
      if (!(dimension.field in view.dimensions)) {
        throw new InvalidRequestError(
          `Invalid dimension ${dimension.field}. Must be one of ${Object.keys(view.dimensions)}`,
        );
      }
      const dim = view.dimensions[dimension.field];
      return {
        ...dim,
        table: dim.relationTable || view.name,
        explodeArray: dim.explodeArray,
        pairExpand: dim.pairExpand,
      };
    });
  }

  private mapMetrics(
    metrics: Array<{
      measure: string;
      aggregation: z.infer<typeof metricAggregations>;
    }>,
    view: ViewDeclarationType,
  ): AppliedMetricType[] {
    return metrics.map((metric) => {
      if (!(metric.measure in view.measures)) {
        throw new InvalidRequestError(
          `Invalid metric ${metric.measure}. Must be one of ${Object.keys(view.measures)}`,
        );
      }
      const measureDef = view.measures[metric.measure];
      const validAggs = getValidAggregationsForMeasureType(measureDef.type);
      if (!validAggs.includes(metric.aggregation)) {
        throw new InvalidRequestError(
          `Aggregation "${metric.aggregation}" is not valid for measure "${metric.measure}" (type: ${measureDef.type}). Valid aggregations: ${validAggs.join(", ")}`,
        );
      }
      return {
        ...view.measures[metric.measure],
        aggregation: metric.aggregation,
        aggs: view.measures[metric.measure].aggs,
        measureName: metric.measure,
      };
    });
  }

  private validateFilters(
    filters: z.infer<typeof queryModel>["filters"],
    view: ViewDeclarationType,
  ) {
    for (const filter of filters) {
      // Validate filters on dimension fields
      if (filter.column in view.dimensions) {
        const dimension = view.dimensions[filter.column];

        // Array fields (like tags) validation
        if (dimension.type === "string[]") {
          if (filter.type === "string") {
            throw new InvalidRequestError(
              `Invalid filter for field '${filter.column}': Array fields require type 'arrayOptions', not 'string'. ` +
                `Use operators like 'any of', 'all of', or 'none of' with an array of values.`,
            );
          }

          // Additional validation: ensure value is array for arrayOptions
          if (filter.type === "arrayOptions" && !Array.isArray(filter.value)) {
            throw new InvalidRequestError(
              `Invalid filter for field '${filter.column}': arrayOptions type requires an array of values, not '${typeof filter.value}'.`,
            );
          }
        }
      }

      // Special validation for metadata filters
      else if (filter.column === "metadata") {
        if (filter.type !== "stringObject") {
          throw new InvalidRequestError(
            `Invalid filter for field 'metadata': Metadata filters require type 'stringObject' with a 'key' property, not '${filter.type}'. ` +
              `Example: {"column": "metadata", "type": "stringObject", "key": "environment", "operator": "=", "value": "production"}`,
          );
        }

        // Validate stringObject has required key
        if (filter.type === "stringObject" && !("key" in filter)) {
          throw new InvalidRequestError(
            `Invalid filter for field 'metadata': stringObject type requires a 'key' property to specify which metadata field to filter on. ` +
              `Example: {"column": "metadata", "type": "stringObject", "key": "environment", "operator": "=", "value": "production"}`,
          );
        }

        // Validate stringObject value type
        if (
          filter.type === "stringObject" &&
          typeof filter.value !== "string"
        ) {
          throw new InvalidRequestError(
            // @ts-ignore
            `Invalid filter for field 'metadata': stringObject type requires a string value, not '${typeof filter.value}'.`,
          );
        }
      }
    }
  }

  private actualTableName(view: ViewDeclarationType): string {
    // Extract actual table name from baseCte (e.g., "events_core events_traces" -> "events_core")
    return view.baseCte.split(" ")[0];
  }

  private tableAlias(view: ViewDeclarationType): string {
    // Return the alias from baseCte if present, otherwise the table name.
    // e.g., "events_core events_traces" -> "events_traces"
    //       "traces FINAL"              -> "traces"  (FINAL is a modifier, not an alias)
    const parts = view.baseCte.split(/\s+/);
    // FINAL, SAMPLE, PREWHERE are legacy CH modifiers that may still appear in
    // imported baseCte strings; ignore them when extracting the alias.
    const dorisModifiers = new Set(["FINAL", "SAMPLE", "PREWHERE"]);
    if (parts.length >= 2 && !dorisModifiers.has(parts[1].toUpperCase())) {
      return parts[1];
    }
    return parts[0];
  }

  /**
   * Resolves a filter column to a dimension, with fallback for *Name columns.
   */
  private resolveDimension(
    filterColumn: string,
    view: ViewDeclarationType,
  ): ViewDeclarationType["dimensions"][string] | undefined {
    if (filterColumn in view.dimensions) {
      return view.dimensions[filterColumn];
    }
    // Fallback: scoreName/traceName → "name" dimension (LFE-4838)
    if (filterColumn.endsWith("Name") && "name" in view.dimensions) {
      return view.dimensions["name"];
    }
    return undefined;
  }

  /**
   * Builds a WHERE condition for a filterSql dimension:
   *   (col1 OP X OR col2 OP X) AND dimensionSql OP X
   *
   * The OR'd part is pruning-friendly (helps skip data blocks).
   * The exact part uses the dimension's row-level sql expression for correctness.
   * Both delegate to createFilterFromFilterState for full operator/type support.
   */
  private buildFilterSqlWhereCondition(params: {
    filter: z.infer<typeof queryModel>["filters"][number];
    whereCols: string[];
    dimensionSql: string;
    tableName: string;
  }): RawSqlPart {
    const { filter, whereCols, dimensionSql, tableName } = params;

    const syntheticMapping = (select: string) => [
      {
        uiTableName: filter.column,
        uiTableId: filter.column,
        tableName: tableName,
        select: select,
        queryPrefix: "",
      },
    ];

    // Pruning: one filter per where column, OR'd together
    const pruneApplied = whereCols.map((col) => {
      const filters = createFilterFromFilterState(
        [filter],
        syntheticMapping(col),
      );
      return filters[0].apply();
    });
    const pruneQuery = `(${pruneApplied.map((p) => p.query).join(" OR ")})`;
    const pruneParams = pruneApplied.reduce<Record<string, unknown>>(
      (acc, p) => ({ ...acc, ...p.params }),
      {},
    );

    // Exact match: filter on the dimension's row-level sql expression
    const exactFilters = createFilterFromFilterState(
      [filter],
      syntheticMapping(dimensionSql),
    );
    const exactApplied = exactFilters[0].apply();

    return {
      query: `${pruneQuery} AND ${exactApplied.query}`,
      params: { ...pruneParams, ...exactApplied.params },
    };
  }

  private mapFilters(
    filters: z.infer<typeof queryModel>["filters"],
    view: ViewDeclarationType,
  ): MappedFilters {
    // Validate all filters before processing
    this.validateFilters(filters, view);

    const actualTableName = this.actualTableName(view);

    const result: MappedFilters = {
      whereFilters: [],
      whereRawParts: [],
    };

    // Separate filters into normal (createFilterFromFilterState) and filterSql-aware
    const normalFilters: z.infer<typeof queryModel>["filters"] = [];
    const normalMappings: Array<{
      uiTableName: string;
      uiTableId: string;
      tableName: string;
      select: string;
      queryPrefix: string;
      type: string;
      emptyEqualsNull?: boolean;
    }> = [];

    for (const filter of filters) {
      const dimension = this.resolveDimension(filter.column, view);

      // Dimension with filterSql: pruning OR + exact match, both in WHERE
      if (dimension?.filterSql) {
        result.whereRawParts.push(
          this.buildFilterSqlWhereCondition({
            filter,
            whereCols: dimension.filterSql.where,
            dimensionSql: dimension.sql,
            tableName: actualTableName,
          }),
        );
        continue;
      }

      // Normal dimension or special-case filter: build column mapping
      let select: string;
      let queryPrefix: string = "";
      let tableName: string = actualTableName;
      let type: string;
      let emptyEqualsNull: boolean | undefined;

      if (dimension) {
        // Dimension with nullIf(col, ''): use raw column with emptyEqualsNull
        // flag for index-friendly filtering while preserving '' ≡ NULL semantic.
        const nullIfMatch = NULL_IF_EMPTY_RE.exec(dimension.sql);
        if (nullIfMatch) {
          select = nullIfMatch[1];
          emptyEqualsNull = true;
        } else {
          select = dimension.sql;
        }
        type = "string";
        if (dimension.relationTable) {
          tableName = dimension.relationTable;
        }
        // Filters on measures are underdefined and not allowed in the initial version
        // } else if (filter.column in view.measures) {
        //   const measure = view.measures[filter.column];
        //   select = measure.sql;
        //   type = measure.type;
        //   if (measure.relationTable) {
        //     tableName = measure.relationTable;
        //   }
      } else if (filter.column === view.timeDimension) {
        select = view.timeDimension;
        queryPrefix = tableName;
        type = "datetime";
      } else if (filter.column === "metadata") {
        select = "metadata";
        queryPrefix = tableName;
        type = "stringObject";
      } else if (filter.column.endsWith("Name")) {
        // Sometimes, the filter does not update correctly and sends us scoreName instead of name for scores, etc.
        // If this happens, none of the conditions above apply, and we use this fallback to avoid raising an error.
        // As this is hard to catch, we include this workaround. (LFE-4838).
        select = "name";
        queryPrefix = tableName;
        type = "string";
      } else {
        throw new InvalidRequestError(
          `Invalid filter column ${filter.column}. Must be one of ${Object.keys(view.dimensions)} or ${view.timeDimension}`,
        );
      }

      normalFilters.push(filter);
      normalMappings.push({
        uiTableName: filter.column,
        uiTableId: filter.column,
        tableName,
        select,
        queryPrefix,
        type,
        emptyEqualsNull,
      });
    }

    // Create filters for non-filterSql dimensions using existing infrastructure
    result.whereFilters = createFilterFromFilterState(
      normalFilters,
      normalMappings,
    );
    return result;
  }

  private addStandardFilters(
    filterList: FilterList,
    view: ViewDeclarationType,
    projectId: string,
    fromTimestamp: string,
    toTimestamp: string,
  ) {
    const actualTableName = this.actualTableName(view);

    // Create column mappings for standard filters
    const projectIdMapping = {
      uiTableName: "project_id",
      uiTableId: "project_id",
      tableName: actualTableName,
      select: "project_id",
      queryPrefix: actualTableName,
      type: "string",
    };

    const timeDimensionMapping = {
      uiTableName: view.timeDimension,
      uiTableId: view.timeDimension,
      tableName: actualTableName,
      select: view.timeDimension,
      queryPrefix: actualTableName,
      type: "datetime",
    };

    // Add project_id filter
    const projectIdFilter = createFilterFromFilterState(
      [
        {
          column: "project_id",
          operator: "=",
          value: projectId,
          type: "string",
        },
      ],
      [projectIdMapping],
    );

    // Add fromTimestamp filter
    const fromFilter = createFilterFromFilterState(
      [
        {
          column: view.timeDimension,
          operator: ">=",
          value: new Date(fromTimestamp),
          type: "datetime",
        },
      ],
      [timeDimensionMapping],
    );

    // Add toTimestamp filter
    const toFilter = createFilterFromFilterState(
      [
        {
          column: view.timeDimension,
          operator: "<=",
          value: new Date(toTimestamp),
          type: "datetime",
        },
      ],
      [timeDimensionMapping],
    );

    // Add all filters to the filter list
    filterList.push(...projectIdFilter, ...fromFilter, ...toFilter);

    // Add segment filters if any
    if (view.segments.length > 0) {
      // Create column mappings for segment filters
      const segmentsMappings = view.segments.map((segment) => ({
        uiTableName: segment.column,
        uiTableId: segment.column,
        tableName: view.name,
        select: segment.column,
        queryPrefix: view.name,
        type: segment.type,
      }));

      const segmentFilters = createFilterFromFilterState(
        view.segments,
        segmentsMappings,
      );
      filterList.push(...segmentFilters);
    }

    return filterList;
  }

  private collectRelationTables(
    view: ViewDeclarationType,
    appliedDimensions: AppliedDimensionType[],
    appliedMetrics: AppliedMetricType[],
    filters: FilterList,
  ) {
    const relationTables = new Set<string>();
    const actualTableName = this.actualTableName(view);

    appliedDimensions.forEach((dimension) => {
      if (dimension.relationTable) {
        relationTables.add(dimension.relationTable);
      }
    });
    appliedMetrics.forEach((metric) => {
      if (metric.relationTable) {
        relationTables.add(metric.relationTable);
      }
    });
    filters.forEach((filter) => {
      // Only add as relation table if it's not the base table
      if (filter.table !== view.name && filter.table !== actualTableName) {
        relationTables.add(filter.table);
      }
    });
    return relationTables;
  }

  private canUseSingleLevelQuery(
    appliedDimensions: AppliedDimensionType[],
    appliedMetrics: AppliedMetricType[],
  ): boolean {
    // Single-level query requires:
    // 1. All metrics are single-level compatible, which means either:
    //    a. They have aggs configuration (@@AGGN@@ templates that resolve to function
    //       calls), OR
    //    b. They are pairExpand value-alias measures (requiresDimension is set). These
    //       reference a plain column brought into scope by the ARRAY JOIN clause and
    //       work correctly with a direct sum()/avg() in a single SELECT.
    // 2. No custom aggregation functions on dimensions
    // Measures without either (like uniq(scores.id)) must use the two-level approach.
    const allMetricsHaveAggs =
      appliedMetrics.length === 0 ||
      appliedMetrics.every(
        (m) => m.aggs !== undefined || m.requiresDimension !== undefined,
      );

    // Check if any dimension has custom aggregation
    const hasCustomDimensionAgg = appliedDimensions.some(
      (d) => d.aggregationFunction !== undefined,
    );

    return allMetricsHaveAggs && !hasCustomDimensionAgg;
  }

  private substituteAggTemplates(
    sql: string,
    aggs: Record<string, string>,
  ): string {
    let result = sql;
    // Replace each @@AGGN@@ placeholder with its corresponding value
    for (const [placeholder, replacement] of Object.entries(aggs)) {
      const marker = `@@${placeholder.toUpperCase()}@@`;
      result = result.replaceAll(marker, replacement);
    }
    return result;
  }

  private buildJoins(
    relationTables: Set<string>,
    view: ViewDeclarationType,
    filterList: FilterList,
    query: QueryType,
    skipObservationsFinal: boolean,
  ) {
    const relationJoins = [];
    for (const relationTableName of relationTables) {
      if (!(relationTableName in view.tableRelations)) {
        throw new InvalidRequestError(
          `Invalid relationTable: ${relationTableName}. Must be one of ${Object.keys(view.tableRelations)}`,
        );
      }

      const relation = view.tableRelations[relationTableName];
      // Conditionally add FINAL - skip for observations if flag is set, and respect per-relation useFinal
      const shouldUseFinal =
        (relation.useFinal ?? true) &&
        !(relation.name === "observations" && skipObservationsFinal);
      const alias =
        relation.name !== relationTableName ? ` AS ${relationTableName}` : "";
      let joinStatement = `INNER JOIN ${relation.name}${alias}${shouldUseFinal ? " FINAL" : ""} ${relation.joinConditionSql}`;

      // Create time dimension mapping for the relation table
      const relationTimeDimensionMapping = {
        uiTableName: relation.timeDimension,
        uiTableId: relation.timeDimension,
        tableName: relation.name,
        select: relation.timeDimension,
        queryPrefix: relationTableName,
        type: "datetime",
      };

      // Add relation-specific timestamp filters
      const fromFilter = createFilterFromFilterState(
        [
          {
            column: relation.timeDimension,
            operator: ">=",
            value: new Date(query.fromTimestamp),
            type: "datetime",
          },
        ],
        [relationTimeDimensionMapping],
      );

      const toFilter = createFilterFromFilterState(
        [
          {
            column: relation.timeDimension,
            operator: "<=",
            value: new Date(query.toTimestamp),
            type: "datetime",
          },
        ],
        [relationTimeDimensionMapping],
      );

      // Add filters to the filter list
      filterList.push(...fromFilter, ...toFilter);

      relationJoins.push(joinStatement);
    }
    return relationJoins;
  }

  private buildArrayJoinClause(
    appliedDimensions: AppliedDimensionType[],
  ): string {
    const pairs = appliedDimensions.filter((d) => d.pairExpand);
    if (pairs.length === 0) return "";
    // Multiple pairExpand dimensions would produce separate ARRAY JOIN clauses
    // which would execute as a cartesian product — almost certainly wrong.
    if (pairs.length > 1) {
      throw new InvalidRequestError(
        `Only one pairExpand dimension is supported per query. Found: ${pairs.map((d) => d.alias ?? d.sql).join(", ")}`,
      );
    }
    const d = pairs[0];
    return `ARRAY JOIN\n  ${d.sql} AS ${d.alias ?? d.sql},\n  ${d.pairExpand!.valuesSql} AS ${d.pairExpand!.valueAlias}`;
  }

  private buildJoinsDoris(
    relationTables: Set<string>,
    view: ViewDeclarationType,
    filterList: FilterList,
    query: QueryType,
  ) {
    const relationJoins = [];
    for (const relationTableName of relationTables) {
      if (!(relationTableName in view.tableRelations)) {
        throw new InvalidRequestError(
          `Invalid relationTable: ${relationTableName}. Must be one of ${Object.keys(view.tableRelations)}`,
        );
      }

      const relation = view.tableRelations[relationTableName];
      const aliasClause =
        relation.name !== relationTableName ? ` AS ${relationTableName}` : "";
      let joinStatement = `LEFT JOIN ${relation.name}${aliasClause} ${relation.joinConditionSql}`;

      // Create time dimension mapping for the relation table
      const relationTimeDimensionMapping = {
        uiTableName: relation.timeDimension,
        uiTableId: relation.timeDimension,
        tableName: relationTableName,
        select: relation.timeDimension,
        queryPrefix: relationTableName,
        type: "datetime",
      };

      // Add relation-specific timestamp filters
      const fromFilter = createDorisFilterFromFilterState(
        [
          {
            column: relation.timeDimension,
            operator: ">=",
            value: new Date(query.fromTimestamp),
            type: "datetime",
          },
        ],
        [relationTimeDimensionMapping],
      );

      const toFilter = createDorisFilterFromFilterState(
        [
          {
            column: relation.timeDimension,
            operator: "<=",
            value: new Date(query.toTimestamp),
            type: "datetime",
          },
        ],
        [relationTimeDimensionMapping],
      );

      // Add filters to the filter list
      filterList.push(...fromFilter, ...toFilter);

      relationJoins.push(joinStatement);
    }
    return relationJoins;
  }

  private buildWhereClause(
    filterList: FilterList,
    parameters: Record<string, unknown>,
  ) {
    if (filterList.length() === 0) return "";

    // Use the FilterList's apply method to get the query and parameters
    const { query, params } = filterList.apply();

    // Add all parameters to the main parameters object
    Object.assign(parameters, params);

    // Return the WHERE clause with the query
    return ` WHERE ${query}`;
  }

  private determineTimeGranularity(
    fromTimestamp: string,
    toTimestamp: string,
  ): z.infer<typeof granularities> {
    const from = new Date(fromTimestamp);
    const to = new Date(toTimestamp);
    const diffMs = to.getTime() - from.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    // Choose appropriate granularity based on date range to get ~50 buckets
    if (diffHours < 2) {
      return "minute"; // Less than a 2h, use minutes
    } else if (diffHours < 72) {
      return "hour"; // Less than 3 days, use hours
    } else if (diffHours < 1440) {
      return "day"; // Less than 60 days, use days
    } else if (diffHours < 8760) {
      return "week"; // Less than a year, use weeks
    } else {
      return "month"; // Over a year, use months
    }
  }

  private getTimeDimensionSql(
    sql: string,
    granularity: z.infer<typeof granularities>,
  ): string {
    return this.getTimeDimensionSqlDoris(sql, granularity);
  }

  private buildTimeDimensionSql(
    view: ViewDeclarationType,
    query: QueryType,
    wrapInAgg?: string,
  ): string {
    if (!query.timeDimension) {
      return "";
    }

    const actualTableName = this.actualTableName(view);
    const granularity =
      query.timeDimension.granularity === "auto"
        ? this.determineTimeGranularity(query.fromTimestamp, query.toTimestamp)
        : query.timeDimension.granularity;

    const timeDimensionSql = this.getTimeDimensionSql(
      `${actualTableName}.${view.timeDimension}`,
      granularity,
    );

    // Optionally wrap in aggregation function (e.g., "any" for two-level inner SELECT).
    // When the view has a rootEventCondition, prefer the root event's timestamp for
    // time bucketing. Falls back to min(start_time) when no root event exists for a
    // trace (e.g. parent_span_id is not populated).
    let wrappedSql: string;
    if (wrapInAgg && view.rootEventCondition) {
      const alias = this.tableAlias(view);
      wrappedSql = `ifNull(anyIf(toNullable(${timeDimensionSql}), ${alias}.${view.rootEventCondition.condition}), min(${timeDimensionSql}))`;
    } else if (wrapInAgg) {
      wrappedSql = `${wrapInAgg}(${timeDimensionSql})`;
    } else {
      wrappedSql = timeDimensionSql;
    }

    return `${wrappedSql} as time_dimension`;
  }

  private getTimeDimensionSqlDoris(
    sql: string,
    granularity: z.infer<typeof granularities>,
  ): string {
    switch (granularity) {
      case "minute":
        return `date_trunc(${sql}, 'minute')`;
      case "hour":
        return `date_trunc(${sql}, 'hour')`;
      case "day":
        return `date_trunc(${sql}, 'day')`;
      case "week":
        return `date_trunc(${sql}, 'week')`;
      case "month":
        return `date_trunc(${sql}, 'month')`;
      case "auto":
        throw new Error(
          `Granularity 'auto' is not supported for getTimeDimensionSqlDoris`,
        );
      default:
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const exhaustiveCheck: never = granularity;
        throw new InvalidRequestError(
          `Invalid time granularity: ${granularity}. Must be one of minute, hour, day, week, month`,
        );
    }
  }

  private buildInnerDimensionsPart(
    appliedDimensions: AppliedDimensionType[],
    query: QueryType,
    view: ViewDeclarationType,
  ) {
    const parts: string[] = [];

    // Add regular dimensions
    if (appliedDimensions.length > 0) {
      for (const dimension of appliedDimensions) {
        // Use custom aggregation function if specified (e.g., argMaxIf for events table traces)
        if (dimension.aggregationFunction) {
          parts.push(
            `${dimension.aggregationFunction} as ${dimension.alias ?? dimension.sql}`,
          );
        }
        // pairExpand key columns (e.g. costType) are added to the inner GROUP BY in
        // buildInnerSelect, so they are already deterministic grouping keys here.
        // Unlike regular dimensions (which are not in GROUP BY and need any() to satisfy
        // aggregation rules), wrapping in any() would be wrong: it implies
        // the value is non-deterministic within the group when it's actually the axis
        // being grouped on. Use a bare reference instead.
        // Note: the paired value column (e.g. cost_value) is NOT in GROUP BY and IS
        // wrapped in any() in buildInnerMetricsPart, so the outer query can re-aggregate it.
        else if (dimension.pairExpand) {
          parts.push(
            `${dimension.alias} as ${dimension.alias ?? dimension.sql}`,
          );
        }
        // Explode array dimensions using arrayJoin
        else if (dimension.explodeArray) {
          parts.push(
            `arrayJoin(${dimension.sql}) as ${dimension.alias ?? dimension.sql}`,
          );
        }
        // Default: wrap in any()
        else {
          parts.push(
            `any(${dimension.sql}) as ${dimension.alias ?? dimension.sql}`,
          );
        }
      }
    }

    // Add time dimension if specified - reuse unified builder with any() wrapper
    const timeDimensionSql = this.buildTimeDimensionSql(view, query, "any");
    if (timeDimensionSql) {
      parts.push(timeDimensionSql);
    }

    return parts.length > 0 ? `${parts.join(",\n")},` : "";
  }

  private buildInnerDimensionsPartDoris(
    appliedDimensions: AppliedDimensionType[],
    query: QueryType,
    view: ViewDeclarationType,
  ) {
    const parts: string[] = [];

    // Skip dimensions that are already in the inner GROUP BY (id and project_id are always included)
    // These are added by buildInnerSelect and would cause duplicate column errors if added again
    const skipIds = ["id", "project_id"];

    // Add regular dimensions
    if (appliedDimensions.length > 0) {
      const filteredDims = appliedDimensions.filter(
        (d) => skipIds.indexOf(d.sql) === -1,
      );
      for (const dimension of filteredDims) {
        // Check if dimension.sql already includes table prefix (e.g., "observations.field")
        // OR if it's a function call (contains parentheses) - in both cases don't add table prefix
        const isFunctionCall = dimension.sql.includes("(");

        // For explodeArray dimensions (like toolNames, calledToolNames), don't add table prefix
        // For function calls, don't add table prefix either
        let sqlWithPrefix: string;
        if (dimension.pairExpand?.valuesSql) {
          // pairExpand dimensions on Doris: the key alias comes from LATERAL VIEW,
          // not from the table — skip table prefix and any_value wrapper
          parts.push(
            `${dimension.alias ?? dimension.sql} as ${dimension.alias ?? dimension.sql}`,
          );
          continue;
        } else if (dimension.explodeArray) {
          // explodeArray dimensions - use as-is without any wrapper (will be handled in GROUP BY)
          sqlWithPrefix = dimension.sql;
        } else if (dimension.sql.includes(".") || isFunctionCall) {
          sqlWithPrefix = dimension.sql;
        } else {
          sqlWithPrefix = `${dimension.table}.${dimension.sql}`;
        }
        parts.push(
          `any_value(${sqlWithPrefix}) as ${dimension.alias ?? dimension.sql}`,
        );
      }
    }

    // Add time dimension if specified
    if (query.timeDimension) {
      const granularity =
        query.timeDimension.granularity === "auto"
          ? this.determineTimeGranularity(
              query.fromTimestamp,
              query.toTimestamp,
            )
          : query.timeDimension.granularity;

      const timeDimensionSql = this.getTimeDimensionSqlDoris(
        `${view.name}.${view.timeDimension}`,
        granularity,
      );
      parts.push(`any_value(${timeDimensionSql}) as time_dimension`);
    }

    return parts.length > 0 ? `${parts.join(",\n")},` : "";
  }

  private buildInnerMetricsPart(appliedMetrics: AppliedMetricType[]) {
    if (appliedMetrics.length === 0) {
      return "count(*) as count";
    }

    return appliedMetrics
      .map((metric) => {
        let sql = metric.sql;

        // For two-level queries, substitute @@AGGN@@ with actual agg function from template
        if (metric.aggs) {
          sql = this.substituteAggTemplates(sql, metric.aggs);
        }

        // pairExpand value-alias measures (e.g. costByType, usageByType) reference a raw
        // column brought into scope by the ARRAY JOIN clause. That column is not in the
        // inner GROUP BY, so wrap it in any(). The outer query then
        // applies the real aggregation. We scope this to requiresDimension metrics only —
        // other measures use @@AGGN@@ templates that resolve to function calls, so they
        // never need this treatment.
        if (metric.requiresDimension && !sql.includes("(")) {
          sql = `any(${sql})`;
        }

        return `${sql} as ${metric.alias || metric.sql}`;
      })
      .join(",\n");
  }

  private buildInnerMetricsPartDoris(appliedMetrics: AppliedMetricType[]) {
    if (appliedMetrics.length === 0) {
      return "count(*) as count";
    }

    // Doris 不能处理重复的列名，需要去重相同的 SQL 表达式
    const uniqueMetrics = new Map<string, string>();

    appliedMetrics.forEach((metric) => {
      const columnAlias = metric.alias || metric.sql;
      // 如果已经有相同的 SQL 表达式，就不重复添加
      if (!uniqueMetrics.has(metric.sql)) {
        uniqueMetrics.set(metric.sql, columnAlias);
      }
    });

    // 判断 SQL 是否已经是聚合函数
    const isAggregateFunction = (sql: string): boolean => {
      const aggregateFuncs = [
        "count(",
        "sum(",
        "avg(",
        "min(",
        "max(",
        "any_value(",
        "any(",
      ];
      return aggregateFuncs.some((func) => sql.toLowerCase().includes(func));
    };

    // 转换为数组并生成 SQL
    // 需要用 any_value() 包装非聚合函数的 metric，因为外层还会再做聚合
    return Array.from(uniqueMetrics.entries())
      .map(([sql, alias]) => {
        if (isAggregateFunction(sql)) {
          return `${sql} as ${alias}`;
        }
        return `any_value(${sql}) as ${alias}`;
      })
      .join(",\n");
  }

  private buildInnerSelect(
    view: ViewDeclarationType,
    innerDimensionsPart: string,
    innerMetricsPart: string,
    fromClause: string,
    appliedDimensions: AppliedDimensionType[],
  ) {
    const alias = this.tableAlias(view);
    // Use actual SQL from view definition for id column (handles events.span_id -> id mapping)
    const rawIdSql = view.dimensions.id?.sql || "id";
    // Qualify id with table alias to avoid ambiguity in JOINs
    const idSql = rawIdSql.includes(".") ? rawIdSql : `${alias}.${rawIdSql}`;
    const projectIdSql = `${alias}.project_id`;

    // Build inner GROUP BY - include exploded array dimensions (they must be in GROUP BY after arrayJoin)
    // Also include pairExpand dimensions (their key column is in scope after ARRAY JOIN clause)
    // NOTE: For Doris, we don't include explodeArray dimensions in GROUP BY because Doris
    // doesn't support GROUP BY on ARRAY type columns
    const groupByParts = [projectIdSql, idSql];
    for (const dim of appliedDimensions) {
      if (dim.pairExpand) {
        // pairExpand is a legacy feature
        groupByParts.push(dim.alias ?? dim.sql);
      }
      // Skip explodeArray for Doris - ARRAY types can't be in GROUP BY
    }

    // Build SELECT parts - handle comma correctly between id, dimensions, and metrics
    const selectParts = [projectIdSql, idSql];
    // innerDimensionsPart ends with comma if non-empty, so we trim the trailing comma
    const trimmedDimensions = innerDimensionsPart.replace(/,\s*$/, "");
    if (trimmedDimensions) {
      selectParts.push(trimmedDimensions);
    }
    // innerMetricsPart also needs comma handling
    const trimmedMetrics = innerMetricsPart.replace(/^,\s*/, "");

    return `
      SELECT
        ${selectParts.join(",\n        ")}
        ${trimmedMetrics ? `,${trimmedMetrics}` : ""}
        ${fromClause}
      GROUP BY ${groupByParts.join(", ")}`;
  }

  private buildOuterDimensionsPart(
    appliedDimensions: AppliedDimensionType[],
    hasTimeDimension: boolean,
  ) {
    let dimensions = "";

    // Add regular dimensions
    if (appliedDimensions.length > 0) {
      dimensions += `${appliedDimensions
        .map(
          (dimension) =>
            `${dimension.alias ?? dimension.sql} as ${dimension.alias || dimension.sql}`,
        )
        .join(",\n")},`;
    }

    // Add time dimension if it exists
    if (hasTimeDimension) {
      dimensions += `time_dimension,`;
    }

    return dimensions;
  }

  private buildOuterMetricsPart(appliedMetrics: AppliedMetricType[]) {
    return appliedMetrics.length > 0
      ? `${appliedMetrics.map((metric) => `${this.translateAggregation(metric)} as ${metric.aggregation}_${metric.alias || metric.sql}`).join(",\n")}`
      : "count(*) as count";
  }

  private buildOuterMetricsPartDoris(appliedMetrics: AppliedMetricType[]) {
    return appliedMetrics.length > 0
      ? `${appliedMetrics.map((metric) => `${this.translateAggregationDoris(metric)} as ${metric.aggregation}_${metric.alias || metric.sql}`).join(",\n")}`
      : "count(*) as count";
  }

  private buildGroupByClause(
    appliedDimensions: AppliedDimensionType[],
    hasTimeDimension: boolean,
  ) {
    const dimensions = [];

    // Add regular dimensions
    if (appliedDimensions.length > 0) {
      dimensions.push(
        ...appliedDimensions.map(
          (dimension) => dimension.alias ?? dimension.sql,
        ),
      );
    }

    // Add time dimension if it exists
    if (hasTimeDimension) {
      dimensions.push("time_dimension");
    }

    return dimensions.length > 0 ? `GROUP BY ${dimensions.join(",\n")}` : "";
  }

  /**
   * Builds a WITH FILL clause for time dimension to ensure continuous time series data.
   * This fills in gaps in the time series with zero values based on the granularity.
   * Only applied if timeDimension is used and no ORDER BY is specified.
   */
  private buildWithFillClause(
    timeDimension: {
      granularity: z.infer<typeof granularities>;
    } | null,
    fromTimestamp: string,
    toTimestamp: string,
    orderBy: Array<{ field: string; direction: string }> | null,
    parameters: Record<string, unknown>,
  ): string {
    if (!timeDimension) {
      return "";
    }

    if (orderBy && orderBy.length > 0) {
      return ""; // Skip WITH FILL if ORDER BY is specified
    }

    // Determine granularity for WITH FILL if timeDimension is used
    const granularity =
      timeDimension.granularity === "auto"
        ? this.determineTimeGranularity(fromTimestamp, toTimestamp)
        : timeDimension.granularity;

    // Calculate appropriate STEP for WITH FILL based on granularity
    let step: string;
    switch (granularity) {
      case "minute":
        step = "INTERVAL 1 MINUTE";
        break;
      case "hour":
        step = "INTERVAL 1 HOUR";
        break;
      case "day":
        step = "INTERVAL 1 DAY";
        break;
      case "week":
        step = "INTERVAL 1 WEEK";
        break;
      case "month":
        step = "INTERVAL 1 MONTH";
        break;
      default:
        step = "INTERVAL 1 DAY"; // Default to day if granularity is unknown
    }

    parameters["fillFromDate"] = convertDateToAnalyticsDateTime(
      new Date(fromTimestamp),
    );
    parameters["fillToDate"] = convertDateToAnalyticsDateTime(
      new Date(toTimestamp),
    );

    return ` WITH FILL FROM ${this.getTimeDimensionSql("{fillFromDate: DateTime64(3)}", granularity)} TO ${this.getTimeDimensionSql("{fillToDate: DateTime64(3)}", granularity)} STEP ${step}`;
  }

  /**
   * Builds a LIMIT clause for the query if row_limit is specified in chartConfig.
   */
  private buildLimitClause(): string {
    const rowLimit = this.chartConfig?.row_limit;
    if (!rowLimit) return "";
    return `LIMIT ${rowLimit}`;
  }

  private buildOuterSelect(
    outerDimensionsPart: string,
    outerMetricsPart: string,
    innerQuery: string,
    groupByClause: string,
    orderByClause: string,
    withFillClause: string,
    limitClause: string,
  ) {
    return `
      SELECT
        ${outerDimensionsPart}
        ${outerMetricsPart}
      FROM (${innerQuery})
      ${groupByClause}
      ${orderByClause}
      ${withFillClause}
      ${limitClause}`;
  }

  private buildSingleLevelMetricsPart(
    appliedMetrics: AppliedMetricType[],
  ): string {
    if (appliedMetrics.length === 0) {
      return "count(*) as count";
    }

    return appliedMetrics
      .map((m) => {
        // For single-level: REMOVE @@AGGN@@ markers (strip template aggregations)
        let baseSql = m.sql;
        if (m.aggs) {
          for (const placeholder of Object.keys(m.aggs)) {
            const marker = `@@${placeholder.toUpperCase()}@@`;
            baseSql = baseSql.replaceAll(marker, "");
          }
        }
        // Apply user-requested aggregation to the stripped SQL
        // Important: Clear alias so translateAggregation uses the sql directly
        const aggregatedSql = this.translateAggregation({
          ...m,
          sql: baseSql,
          alias: undefined, // Force use of sql instead of alias
        });
        return `${aggregatedSql} as ${m.aggregation}_${m.alias || m.sql}`;
      })
      .join(",\n");
  }

  private buildSingleLevelDimensionsPart(
    appliedDimensions: AppliedDimensionType[],
    query: QueryType,
    view: ViewDeclarationType,
  ): string {
    let dimensionsPart = "";
    if (appliedDimensions.length > 0) {
      dimensionsPart =
        appliedDimensions
          .map((d) => {
            if (d.pairExpand) {
              // Bare reference — already projected by the ARRAY JOIN clause
              return `${d.alias} as ${d.alias ?? d.sql}`;
            }
            if (d.explodeArray) {
              return `arrayJoin(${d.sql}) as ${d.alias ?? d.sql}`;
            }
            return `${d.sql} as ${d.alias ?? d.sql}`;
          })
          .join(",\n") + ",\n";
    }

    // Reuse unified time dimension builder (no wrapper for single-level)
    const timeDimensionSql = this.buildTimeDimensionSql(view, query);
    if (timeDimensionSql) {
      dimensionsPart += `${timeDimensionSql},\n`;
    }

    return dimensionsPart;
  }

  private buildSingleLevelSelect(
    view: ViewDeclarationType,
    appliedDimensions: AppliedDimensionType[],
    appliedMetrics: AppliedMetricType[],
    query: QueryType,
    fromClause: string,
    groupByClause: string,
    orderByClause: string,
    withFillClause: string,
    limitClause: string,
  ): string {
    // Build dimensions using dedicated helper
    const dimensionsPart = this.buildSingleLevelDimensionsPart(
      appliedDimensions,
      query,
      view,
    );

    // Build optimized metrics (strip templates, apply user aggregation)
    const metricsPart = this.buildSingleLevelMetricsPart(appliedMetrics);

    return `
      SELECT
        ${dimensionsPart}${metricsPart}
      ${fromClause}
      ${groupByClause}
      ${orderByClause}
      ${withFillClause}
      ${limitClause}`;
  }

  private buildOuterSelectDoris(
    outerDimensionsPart: string,
    outerMetricsPart: string,
    innerQuery: string,
    groupByClause: string,
    orderByClause: string,
    limitClause: string,
  ) {
    return `
      SELECT
        ${outerDimensionsPart}
        ${outerMetricsPart}
      FROM (${innerQuery}) AS subquery
      ${groupByClause}
      ${orderByClause}
      ${limitClause}`;
  }

  /**
   * Validates that the provided orderBy fields exist in the dimensions or metrics
   * and returns the processed orderBy array with fully qualified field names.
   */
  private validateAndProcessOrderBy(
    orderBy: Array<{ field: string; direction: string }> | null,
    appliedDimensions: AppliedDimensionType[],
    appliedMetrics: AppliedMetricType[],
    hasTimeDimension: boolean,
  ): Array<{ field: string; direction: string }> {
    if (!orderBy || orderBy.length === 0) {
      // Default order: time dimension if available, otherwise first metric, otherwise first dimension
      if (hasTimeDimension) {
        return [{ field: "time_dimension", direction: "asc" }];
      } else if (appliedMetrics.length > 0) {
        const firstMetric = appliedMetrics[0];
        return [
          {
            field: `${firstMetric.aggregation}_${firstMetric.alias || firstMetric.sql}`,
            direction: "desc",
          },
        ];
      } else if (appliedDimensions.length > 0) {
        const firstDimension = appliedDimensions[0];
        return [
          {
            field: firstDimension.alias || firstDimension.sql,
            direction: "asc",
          },
        ];
      }
      return [];
    }

    // Validate that each orderBy field exists in dimensions or metrics
    return orderBy.map((item) => {
      // Check if the field is a time dimension
      if (hasTimeDimension && item.field === "time_dimension") {
        return item;
      }

      // Check if the field is a dimension
      const matchingDimension = appliedDimensions.find(
        (dim) => dim.alias === item.field || dim.sql === item.field,
      );
      if (matchingDimension) {
        return {
          field: matchingDimension.alias || matchingDimension.sql,
          direction: item.direction,
        };
      }

      // Check if the field is a metric (with aggregation prefix)
      const metricNamePattern =
        /^(sum|avg|count|max|min|p50|p75|p90|p95|p99|uniq)_(.+)$/;
      const metricMatch = item.field.match(metricNamePattern);

      if (metricMatch) {
        const [, aggregation, measureName] = metricMatch;
        const matchingMetric = appliedMetrics.find(
          (metric) =>
            (metric.alias === measureName || metric.sql === measureName) &&
            metric.aggregation === aggregation,
        );

        if (matchingMetric) {
          return item;
        }
      }

      throw new InvalidRequestError(
        `Invalid orderBy field: ${item.field}. Must be one of the dimension or metric fields.`,
      );
    });
  }

  /**
   * Builds the ORDER BY clause for the query.
   */
  private buildOrderByClause(
    processedOrderBy: Array<{ field: string; direction: string }>,
  ): string {
    if (processedOrderBy.length === 0) {
      return "";
    }

    return `ORDER BY ${processedOrderBy
      .map((item) => `${item.field} ${item.direction}`)
      .join(", ")}`;
  }

  /**
   * Rewrite legacy `metadata['key']` map subscripts (and the equivalent for
   * experiment_item_metadata / experiment_metadata) to the events_full
   * parallel-arrays idiom. Bare `metadata` references get prefixed with the
   * view's base-table alias; explicitly qualified references (e.g. `t.metadata`)
   * keep their prefix.
   */
  private rewriteEventsFullMetadataAccess(sql: string, alias: string): string {
    // Longest-first so "experiment_metadata" and "experiment_item_metadata" are
    // matched before "metadata" — otherwise the shorter pattern would replace
    // the "metadata" suffix inside the longer field name.
    const fields = [
      "experiment_item_metadata",
      "experiment_metadata",
      "metadata",
    ];
    let rewritten = sql;
    for (const field of fields) {
      // \b before the field name prevents matching a longer identifier
      // that happens to end with the field name (defense-in-depth against
      // future field additions).
      const pattern = new RegExp(
        String.raw`(\w+\.)?\b` + field + String.raw`\[\s*'((?:[^']|'')*)'\s*\]`,
        "g",
      );
      rewritten = rewritten.replace(pattern, (_, prefix, key) => {
        const p = prefix ?? `${alias}.`;
        return `element_at(${p}${field}_values, array_position(${p}${field}_names, '${key}'))`;
      });
    }
    return rewritten;
  }

  /**
   * Convert SQL functions to Doris equivalents
   */
  private convertSqlFunctionsToDoris(sql: string): string {
    // Replace bare position() with INSTR() for string operations.
    // The lookbehind ensures we don't accidentally rewrite array_position(
    // (which exists in Doris with the same name) into array_INSTR(.
    sql = sql.replace(/(?<![A-Za-z0-9_])position\s*\(/g, "INSTR(");

    return sql;
  }

  /**
   * We want to build a Doris query based on the query provided and the viewDeclaration that was selected.
   *
   * When enableSingleLevelOptimization is false (default), the query follows a two-level pattern:
   * ```
   *   SELECT
   *     <...dimensions>,
   *     <...metrics.map(metric => `${metric.aggregation}(${metric.alias})`>
   *   FROM (
   *      SELECT
   *        <baseCte>.project_id,
   *        <baseCte>.id
   *        <...dimensions.map(dimension => `any(${dimension.sql}) as ${dimension.alias}`>,
   *        <...metrics.map(metric => `${metric.sql} as ${metric.alias || metric.sql}`>
   *      FROM <baseCte>
   *      (...tableRelations.joinConditionSql)
   *      WHERE <...filters>
   *      GROUP BY <baseCte>.project_id, <baseCte>.id
   *   )
   *   GROUP BY <...dimensions>
   *   ORDER BY <fields with directions>
   * ```
   *
   * When `enableSingleLevelOptimization` is true AND `canUseSingleLevelQuery()` returns true,
   * the query uses a single-level pattern (skips high-cardinality GROUP BY):
   * ```
   *   SELECT
   *     <...dimensions>,
   *     <...metrics.map(metric => `${metric.aggregation}(stripped ${metric.sql})`>
   *   FROM <baseCte>
   *   (...tableRelations.joinConditionSql)
   *   WHERE <...filters>
   *   GROUP BY <...dimensions>
   *   ORDER BY <fields with directions>
   * ```
   *
   * Note: Template placeholders @@AGGN@@ in metric SQL are substituted with:
   * - Two-level mode: Actual aggregation from aggs config (e.g., sum, any, sumMap)
   * - Single-level mode: Stripped out, user's aggregation applied directly to raw expression
   */
  public async build(
    query: QueryType,
    projectId: string,
    enableSingleLevelOptimization: boolean = false,
  ): Promise<{ query: string; parameters: Record<string, unknown> }> {
    // Run zod validation
    const parseResult = queryModel.safeParse(query);
    if (!parseResult.success) {
      throw new InvalidRequestError(
        `Invalid query: ${JSON.stringify(parseResult.error.issues)}`,
      );
    }

    // Check if we should use Doris backend
    return this.buildDoris(query, projectId);
  }

  /**
   * Build Doris-compatible filters using the Doris filter factory.
   */
  private mapFiltersDoris(
    filters: z.infer<typeof queryModel>["filters"],
    view: ViewDeclarationType,
  ): MappedFilters {
    this.validateFilters(filters, view);

    const actualTableName = this.actualTableName(view);

    const result: MappedFilters = {
      whereFilters: [],
      whereRawParts: [],
    };

    const normalFilters: z.infer<typeof queryModel>["filters"] = [];
    const normalMappings: Array<{
      uiTableName: string;
      uiTableId: string;
      tableName: string;
      select: string;
      queryPrefix: string;
      type: string;
      emptyEqualsNull?: boolean;
    }> = [];

    for (const filter of filters) {
      const dimension = this.resolveDimension(filter.column, view);

      if (dimension?.filterSql) {
        result.whereRawParts.push(
          this.buildFilterSqlWhereCondition({
            filter,
            whereCols: dimension.filterSql.where,
            dimensionSql: dimension.sql,
            tableName: actualTableName,
          }),
        );
        continue;
      }

      let select: string;
      let queryPrefix: string = this.tableAlias(view);
      let tableName: string = actualTableName;
      let type: string;
      let emptyEqualsNull: boolean | undefined;

      if (dimension) {
        const nullIfMatch = NULL_IF_EMPTY_RE.exec(dimension.sql);
        if (nullIfMatch) {
          select = nullIfMatch[1];
          emptyEqualsNull = true;
        } else {
          select = dimension.sql;
        }
        type = "string";
        if (dimension.relationTable) {
          tableName = dimension.relationTable;
          queryPrefix = dimension.relationTable;
        }
      } else if (filter.column === view.timeDimension) {
        select = view.timeDimension;
        // queryPrefix must be the SQL alias (e.g. "traces"), not the
        // physical table name (e.g. "events_full"). Otherwise the WHERE
        // emits "events_full.start_time" which fails when baseCte aliases
        // the table to a different name.
        queryPrefix = this.tableAlias(view);
        type = "datetime";
      } else if (filter.column === "metadata") {
        select = "metadata";
        queryPrefix = this.tableAlias(view);
        type = "stringObject";
      } else if (filter.column.endsWith("Name")) {
        select = "name";
        queryPrefix = this.tableAlias(view);
        type = "string";
      } else {
        throw new InvalidRequestError(
          `Invalid filter column ${filter.column}. Must be one of ${Object.keys(view.dimensions)} or ${view.timeDimension}`,
        );
      }

      normalFilters.push(filter);
      normalMappings.push({
        uiTableName: filter.column,
        uiTableId: filter.column,
        tableName,
        select,
        queryPrefix,
        type,
        emptyEqualsNull,
      });
    }

    // Use Doris filter factory
    result.whereFilters = createDorisFilterFromFilterState(
      normalFilters,
      normalMappings,
    );
    return result;
  }

  /**
   * Add standard filters (project_id, timestamps) using Doris filter factory.
   */
  private addStandardFiltersDoris(
    filterList: FilterList,
    view: ViewDeclarationType,
    projectId: string,
    fromTimestamp: string,
    toTimestamp: string,
  ) {
    const alias = this.tableAlias(view);

    const projectIdMapping = {
      uiTableName: "project_id",
      uiTableId: "project_id",
      tableName: alias,
      select: "project_id",
      queryPrefix: alias,
      type: "string",
    };

    const timeDimensionMapping = {
      uiTableName: view.timeDimension,
      uiTableId: view.timeDimension,
      tableName: alias,
      select: view.timeDimension,
      queryPrefix: alias,
      type: "datetime",
    };

    const projectIdFilter = createDorisFilterFromFilterState(
      [
        {
          column: "project_id",
          operator: "=",
          value: projectId,
          type: "string",
        },
      ],
      [projectIdMapping],
    );

    const fromFilter = createDorisFilterFromFilterState(
      [
        {
          column: view.timeDimension,
          operator: ">=",
          value: new Date(fromTimestamp),
          type: "datetime",
        },
      ],
      [timeDimensionMapping],
    );

    const toFilter = createDorisFilterFromFilterState(
      [
        {
          column: view.timeDimension,
          operator: "<=",
          value: new Date(toTimestamp),
          type: "datetime",
        },
      ],
      [timeDimensionMapping],
    );

    filterList.push(...projectIdFilter, ...fromFilter, ...toFilter);

    if (view.segments.length > 0) {
      const segmentsMappings = view.segments.map((segment) => ({
        uiTableName: segment.column,
        uiTableId: segment.column,
        tableName: alias,
        select: segment.column,
        queryPrefix: alias,
        type: segment.type,
      }));

      const segmentFilters = createDorisFilterFromFilterState(
        view.segments,
        segmentsMappings,
      );
      filterList.push(...segmentFilters);
    }

    return filterList;
  }

  /**
   * Build JOINs for Doris using Doris filter factory for timestamp filters.
   */
  private buildJoinsDorisWithDorisFilters(
    relationTables: Set<string>,
    view: ViewDeclarationType,
    filterList: FilterList,
    query: QueryType,
  ) {
    const relationJoins = [];
    for (const relationTableName of relationTables) {
      if (!(relationTableName in view.tableRelations)) {
        throw new InvalidRequestError(
          `Invalid relationTable: ${relationTableName}. Must be one of ${Object.keys(view.tableRelations)}`,
        );
      }

      const relation = view.tableRelations[relationTableName];
      const aliasClause =
        relation.name !== relationTableName ? ` AS ${relationTableName}` : "";
      let joinStatement = `LEFT JOIN ${relation.name}${aliasClause} ${relation.joinConditionSql}`;

      const relationTimeDimensionMapping = {
        uiTableName: relation.timeDimension,
        uiTableId: relation.timeDimension,
        tableName: relationTableName,
        select: relation.timeDimension,
        queryPrefix: relationTableName,
        type: "datetime",
      };

      const fromFilter = createDorisFilterFromFilterState(
        [
          {
            column: relation.timeDimension,
            operator: ">=",
            value: new Date(query.fromTimestamp),
            type: "datetime",
          },
        ],
        [relationTimeDimensionMapping],
      );

      const toFilter = createDorisFilterFromFilterState(
        [
          {
            column: relation.timeDimension,
            operator: "<=",
            value: new Date(query.toTimestamp),
            type: "datetime",
          },
        ],
        [relationTimeDimensionMapping],
      );

      filterList.push(...fromFilter, ...toFilter);
      relationJoins.push(joinStatement);
    }
    return relationJoins;
  }

  private buildDoris(
    query: QueryType,
    projectId: string,
  ): { query: string; parameters: Record<string, unknown> } {
    // Initialize parameters object
    const parameters: Record<string, unknown> = {};

    // Get view declaration (with FINAL removed for Doris)
    const view = this.getViewDeclarationForDoris(query.view);

    // Map dimensions and metrics
    const appliedDimensions = this.mapDimensions(query.dimensions, view);
    const appliedMetrics = this.mapMetrics(query.metrics, view);

    // Auto-include dimensions required by pairExpand-dependent measures.
    // e.g. usageByType.requiresDimension = "usageType": without that dimension
    // the LATERAL VIEW is never emitted and Doris errors with "unknown column".
    for (const metric of appliedMetrics) {
      if (
        metric.requiresDimension &&
        !appliedDimensions.some((d) => d.alias === metric.requiresDimension)
      ) {
        const requiredDimDef = view.dimensions[metric.requiresDimension];
        if (requiredDimDef) {
          appliedDimensions.push({
            ...requiredDimDef,
            table: requiredDimDef.relationTable || view.name,
            explodeArray: requiredDimDef.explodeArray,
            pairExpand: requiredDimDef.pairExpand,
          });
        }
      }
    }

    // Auto-include dimensions required by pairExpand-dependent measures.
    // e.g. usageByType.requiresDimension = "usageType": without that dimension
    // the LATERAL VIEW is never emitted and Doris errors with "unknown column".
    for (const metric of appliedMetrics) {
      if (
        metric.requiresDimension &&
        !appliedDimensions.some((d) => d.alias === metric.requiresDimension)
      ) {
        const requiredDimDef = view.dimensions[metric.requiresDimension];
        if (requiredDimDef) {
          appliedDimensions.push({
            ...requiredDimDef,
            table: requiredDimDef.relationTable || view.name,
            explodeArray: requiredDimDef.explodeArray,
            pairExpand: requiredDimDef.pairExpand,
          });
        }
      }
    }

    // Create filters using Doris filter factory
    const { whereFilters, whereRawParts } = this.mapFiltersDoris(
      query.filters,
      view,
    );
    let filterList = new FilterList(whereFilters);

    // Add standard filters using Doris filter factory
    filterList = this.addStandardFiltersDoris(
      filterList,
      view,
      projectId,
      query.fromTimestamp,
      query.toTimestamp,
    );

    // Build the FROM clause with necessary JOINs
    let fromClause = `FROM ${view.baseCte}`;

    // Handle pairExpand dimensions using LATERAL VIEW (Doris equivalent of ARRAY JOIN)
    // LATERAL VIEW must come right after FROM table, before any JOINs
    const pairDims = appliedDimensions.filter((d) => d.pairExpand?.valuesSql);
    if (pairDims.length > 0) {
      const d = pairDims[0];
      const mapCol = `${view.name}.${d.pairExpand!.valuesSql}`;
      const keyAlias = d.alias ?? d.sql;
      const valAlias = d.pairExpand!.valueAlias;
      fromClause += `\nLATERAL VIEW posexplode(map_keys(${mapCol})) _pe_keys AS _pe_key_pos, ${keyAlias}`;
      fromClause += `\nLATERAL VIEW posexplode(map_values(${mapCol})) _pe_vals AS _pe_val_pos, ${valAlias}`;
    }

    // Handle relation tables (JOINs come after LATERAL VIEW)
    const relationTables = this.collectRelationTables(
      view,
      appliedDimensions,
      appliedMetrics,
      filterList,
    );
    if (relationTables.size > 0) {
      const relationJoins = this.buildJoinsDorisWithDorisFilters(
        relationTables,
        view,
        filterList,
        query,
      );
      fromClause += ` ${relationJoins.join(" ")}`;
    }

    fromClause += this.buildWhereClause(filterList, parameters);

    // pairExpand position matching
    if (pairDims.length > 0) {
      fromClause += ` AND _pe_key_pos = _pe_val_pos AND ${view.name}.${pairDims[0].pairExpand!.valuesSql} IS NOT NULL`;
    }

    // Append raw WHERE pruning parts (OR'd conditions from filterSql.where)
    for (const part of whereRawParts) {
      fromClause += ` AND ${part.query}`;
      Object.assign(parameters, part.params);
    }

    // Append raw SQL filter if provided.
    // The events_full schema stores metadata as parallel arrays, not a Map.
    // Rewrite metadata['key'] style access (familiar from langfuse v3 CH)
    // to Doris's element_at(values, array_position(names, key)) idiom so
    // user-written widget SQL keeps working without per-key Doris knowledge.
    if (query.rawSqlFilter && query.rawSqlFilter.trim().length > 0) {
      const rewritten = this.rewriteEventsFullMetadataAccess(
        query.rawSqlFilter.trim(),
        this.tableAlias(view),
      );
      fromClause += ` AND (${rewritten})`;
    }

    // Build inner SELECT parts
    const innerDimensionsPart = this.buildInnerDimensionsPartDoris(
      appliedDimensions,
      query,
      view,
    );
    const innerMetricsPart = this.buildInnerMetricsPartDoris(appliedMetrics);

    // Build inner SELECT
    const innerQuery = this.buildInnerSelect(
      view,
      innerDimensionsPart,
      innerMetricsPart,
      fromClause,
      appliedDimensions,
    );

    // Build outer SELECT parts
    const outerDimensionsPart = this.buildOuterDimensionsPart(
      appliedDimensions,
      !!query.timeDimension,
    );
    const outerMetricsPart = this.buildOuterMetricsPartDoris(appliedMetrics);
    const groupByClause = this.buildGroupByClause(
      appliedDimensions,
      !!query.timeDimension,
    );

    // Process and validate orderBy fields
    const processedOrderBy = this.validateAndProcessOrderBy(
      query.orderBy,
      appliedDimensions,
      appliedMetrics,
      !!query.timeDimension,
    );

    // Build ORDER BY clause
    const orderByClause = this.buildOrderByClause(processedOrderBy);

    // Build LIMIT clause for row limiting
    const limitClause = this.buildLimitClause();

    // Build final query (Doris doesn't support WITH FILL)
    let sql = this.buildOuterSelectDoris(
      outerDimensionsPart,
      outerMetricsPart,
      innerQuery,
      groupByClause,
      orderByClause,
      limitClause,
    );

    // Replace SQL functions with Doris equivalents
    sql = this.convertSqlFunctionsToDoris(sql);

    return {
      query: sql,
      parameters,
    };
  }
}
