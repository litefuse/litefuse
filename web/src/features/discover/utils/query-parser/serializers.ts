// @ts-nocheck
// @ts-ignore: no type declarations for '@hyperdx/lucene'
import type lucene from "@hyperdx/lucene";
import SqlString from "./sqlstring-browser";
import {
  getColumn as getColumnMetadata,
  getInvertedIndexColumns,
} from "../../services/metaservice";
import { convertCHTypeToPrimitiveJSType, JSDataType } from "./enums";
import { splitAndTrimWithBracket } from "./utils";
import { CLICK_HOUSE_JSON_NUMBER_TYPES, IMPLICIT_FIELD } from "./constants";

export type ColumnLookup = {
  name: string;
  type: string;
  dataType?: string;
  columnType?: string;
};

export type LegacyMetadataProvider = {
  getColumn: (params: {
    databaseName: string;
    tableName: string;
    column: string;
    connectionId?: string;
  }) => Promise<{ name: string; type: string } | null>;
};

type ImplicitTextSearchTarget = {
  column: string;
  sourceColumn: string;
  propertyType?: JSDataType;
  supportsTextSearch?: boolean;
};

export interface Serializer {
  operator(op: lucene.Operator): string;
  eq(field: string, term: string, isNegatedField: boolean): Promise<string>;
  isNotNull(field: string, isNegatedField: boolean): Promise<string>;
  gte(field: string, term: string): Promise<string>;
  lte(field: string, term: string): Promise<string>;
  lt(field: string, term: string): Promise<string>;
  gt(field: string, term: string): Promise<string>;
  fieldSearch(
    field: string,
    term: string,
    isNegatedField: boolean,
    prefixWildcard: boolean,
    suffixWildcard: boolean,
    isPhrase: boolean,
  ): Promise<string>;
  range(
    field: string,
    start: string,
    end: string,
    isNegatedField: boolean,
  ): Promise<string>;
}

export class EnglishSerializer implements Serializer {
  private translateField(field: string) {
    if (field === IMPLICIT_FIELD) {
      return "event";
    }

    return `'${field}'`;
  }

  operator(op: lucene.Operator) {
    switch (op) {
      case "NOT":
      case "AND NOT":
        return "AND NOT";
      case "OR NOT":
        return "OR NOT";
      // @ts-ignore TODO: Types need to be fixed upstream
      case "&&":
      case "<implicit>":
      case "AND":
        return "AND";
      // @ts-ignore TODO: Types need to be fixed upstream
      case "||":
      case "OR":
        return "OR";
      default:
        throw new Error(`Unexpected operator. ${op}`);
    }
  }

  async eq(field: string, term: string, isNegatedField: boolean) {
    return `${this.translateField(field)} ${isNegatedField ? "is not" : "is"} ${term}`;
  }

  async isNotNull(field: string, isNegatedField: boolean) {
    return `${this.translateField(field)} ${isNegatedField ? "is null" : "is not null"}`;
  }

  async gte(field: string, term: string) {
    return `${this.translateField(field)} is greater than or equal to ${term}`;
  }

  async lte(field: string, term: string) {
    return `${this.translateField(field)} is less than or equal to ${term}`;
  }

  async lt(field: string, term: string) {
    return `${this.translateField(field)} is less than ${term}`;
  }

  async gt(field: string, term: string) {
    return `${this.translateField(field)} is greater than ${term}`;
  }

  async fieldSearch(
    field: string,
    term: string,
    isNegatedField: boolean,
    prefixWildcard: boolean,
    suffixWildcard: boolean,
    _isPhrase: boolean,
  ) {
    if (field === IMPLICIT_FIELD) {
      return `${this.translateField(field)} ${
        prefixWildcard && suffixWildcard
          ? isNegatedField
            ? "does not contain"
            : "contains"
          : prefixWildcard
            ? isNegatedField
              ? "does not end with"
              : "ends with"
            : suffixWildcard
              ? isNegatedField
                ? "does not start with"
                : "starts with"
              : isNegatedField
                ? "does not have whole word"
                : "has whole word"
      } ${term}`;
    }

    return `${this.translateField(field)} ${isNegatedField ? "does not contain" : "contains"} ${term}`;
  }

  async range(
    field: string,
    start: string,
    end: string,
    isNegatedField: boolean,
  ) {
    return `${field} ${isNegatedField ? "is not" : "is"} between ${start} and ${end}`;
  }
}

export abstract class SQLSerializer implements Serializer {
  private NOT_FOUND_QUERY = "(1 = 0)";

  abstract getColumnForField(field: string): Promise<{
    column?: string;
    columnJSON?: { string: string; number: string };
    propertyType?: JSDataType;
    supportsTextSearch?: boolean;
    sourceColumn?: string;
    implicitTargets?: ImplicitTextSearchTarget[];
    found: boolean;
  }>;

  operator(op: lucene.Operator) {
    switch (op) {
      case "NOT":
      case "AND NOT":
        return "AND NOT";
      case "OR NOT":
        return "OR NOT";
      // @ts-ignore TODO: Types need to be fixed upstream
      case "&&":
      case "<implicit>":
      case "AND":
        return "AND";
      // @ts-ignore TODO: Types need to be fixed upstream
      case "||":
      case "OR":
        return "OR";
      default:
        throw new Error(`Unexpected operator. ${op}`);
    }
  }

  async eq(field: string, term: string, isNegatedField: boolean) {
    const {
      column,
      columnJSON,
      found,
      propertyType,
      supportsTextSearch,
      sourceColumn,
    } = await this.getColumnForField(field);
    if (!found) {
      return this.NOT_FOUND_QUERY;
    }
    if (propertyType === JSDataType.Bool) {
      const normTerm = `${term}`.trim().toLowerCase();
      return SqlString.format(`(?? ${isNegatedField ? "!" : ""}= ?)`, [
        column,
        normTerm === "true"
          ? 1
          : normTerm === "false"
            ? 0
            : parseInt(normTerm, 10),
      ]);
    } else if (propertyType === JSDataType.Number) {
      return SqlString.format(
        `(${column} ${isNegatedField ? "!" : ""}= CAST(? AS DOUBLE))`,
        [term],
      );
    } else if (propertyType === JSDataType.JSON) {
      return SqlString.format(
        `(${columnJSON?.string} ${isNegatedField ? "!" : ""}= ?)`,
        [term],
      );
    } else if (propertyType === JSDataType.String && supportsTextSearch) {
      const searchTarget = column && column.length > 0 ? column : sourceColumn;
      if (!searchTarget) {
        return this.NOT_FOUND_QUERY;
      }
      return SqlString.format(
        `(? ${isNegatedField ? "NOT " : ""}MATCH_PHRASE ?)`,
        [SqlString.raw(searchTarget), term],
      );
    }
    return SqlString.format(`(${column} ${isNegatedField ? "!" : ""}= ?)`, [
      term,
    ]);
  }

  async isNotNull(field: string, isNegatedField: boolean) {
    const { column, columnJSON, found, propertyType } =
      await this.getColumnForField(field);
    if (!found) {
      return this.NOT_FOUND_QUERY;
    }
    if (propertyType === JSDataType.JSON) {
      return `notEmpty(${columnJSON?.string}) ${isNegatedField ? "!" : ""}= 1`;
    }
    return `notEmpty(${column}) ${isNegatedField ? "!" : ""}= 1`;
  }

  async gte(field: string, term: string) {
    const { column, columnJSON, found, propertyType } =
      await this.getColumnForField(field);
    if (!found) {
      return this.NOT_FOUND_QUERY;
    }
    if (propertyType === JSDataType.JSON) {
      return SqlString.format(`(${columnJSON?.number} >= ?)`, [term]);
    }
    return SqlString.format(`(${column} >= ?)`, [term]);
  }

  async lte(field: string, term: string) {
    const { column, columnJSON, found, propertyType } =
      await this.getColumnForField(field);
    if (!found) {
      return this.NOT_FOUND_QUERY;
    }
    if (propertyType === JSDataType.JSON) {
      return SqlString.format(`(${columnJSON?.number} <= ?)`, [term]);
    }
    return SqlString.format(`(${column} <= ?)`, [term]);
  }

  async lt(field: string, term: string) {
    const { column, columnJSON, found, propertyType } =
      await this.getColumnForField(field);
    if (!found) {
      return this.NOT_FOUND_QUERY;
    }
    if (propertyType === JSDataType.JSON) {
      return SqlString.format(`(${columnJSON?.number} < ?)`, [term]);
    }
    return SqlString.format(`(${column} < ?)`, [term]);
  }

  async gt(field: string, term: string) {
    const { column, columnJSON, found, propertyType } =
      await this.getColumnForField(field);
    if (!found) {
      return this.NOT_FOUND_QUERY;
    }
    if (propertyType === JSDataType.JSON) {
      return SqlString.format(`(${columnJSON?.number} > ?)`, [term]);
    }
    return SqlString.format(`(${column} > ?)`, [term]);
  }

  private attemptToParseNumber(term: string): string | number {
    const number = Number.parseFloat(term);
    if (Number.isNaN(number)) {
      return term;
    }
    return number;
  }

  private tokenizeTerm(term: string): string[] {
    return term.split(/[ -/:-@[-`{-~\t\n\r]+/).filter((t) => t.length > 0);
  }

  private termHasSeperators(term: string): boolean {
    return term.match(/[ -/:-@[-`{-~\t\n\r]+/) != null;
  }

  async fieldSearch(
    field: string,
    term: string,
    isNegatedField: boolean,
    prefixWildcard: boolean,
    suffixWildcard: boolean,
    isPhrase: boolean,
  ) {
    const isImplicitField = field === IMPLICIT_FIELD;
    const {
      column,
      found,
      propertyType,
      supportsTextSearch,
      sourceColumn,
      implicitTargets,
    } = await this.getColumnForField(field);
    if (!found) {
      return this.NOT_FOUND_QUERY;
    }

    if (propertyType === JSDataType.Bool) {
      const normTerm = `${term}`.trim().toLowerCase();
      return SqlString.format(`(?? ${isNegatedField ? "!" : ""}= ?)`, [
        column,
        normTerm === "true"
          ? 1
          : normTerm === "false"
            ? 0
            : parseInt(normTerm, 10),
      ]);
    } else if (propertyType === JSDataType.Number) {
      return SqlString.format(
        `(?? ${isNegatedField ? "!" : ""}= CAST(? AS DOUBLE))`,
        [column, term],
      );
    } else if (
      propertyType === JSDataType.JSON &&
      supportsTextSearch === false
    ) {
      return this.NOT_FOUND_QUERY;
    }

    if (term.length === 0) {
      return "(1=1)";
    }

    if (isImplicitField) {
      if (implicitTargets && implicitTargets.length > 0) {
        const usePhrasePrefix = !isPhrase && suffixWildcard && !prefixWildcard;
        const matchTerm = isPhrase
          ? term
          : usePhrasePrefix
            ? term
            : `${prefixWildcard ? "*" : ""}${term}${suffixWildcard ? "*" : ""}`;
        const clauses = implicitTargets
          .map((target) => {
            if (!target) {
              return null;
            }

            if (
              isPhrase &&
              target.propertyType !== JSDataType.String &&
              target.propertyType !== JSDataType.JSON
            ) {
              return null;
            }

            if (
              (target.propertyType === JSDataType.String ||
                target.propertyType === JSDataType.JSON) &&
              target.supportsTextSearch
            ) {
              const identifier = target.sourceColumn ?? target.column;
              if (!identifier) {
                return null;
              }
              const operator = isPhrase
                ? "MATCH_PHRASE"
                : usePhrasePrefix
                  ? "MATCH_PHRASE_PREFIX"
                  : "MATCH_ANY";
              return SqlString.format(`(?? ${operator} ?)`, [
                identifier,
                matchTerm,
              ]);
            }

            if (target.propertyType === JSDataType.Number) {
              const identifier = target.sourceColumn ?? target.column;
              if (!identifier) {
                return null;
              }
              return SqlString.format(`(?? = CAST(? AS DOUBLE))`, [
                identifier,
                term,
              ]);
            }

            if (target.propertyType === JSDataType.Bool) {
              const identifier = target.sourceColumn ?? target.column;
              if (!identifier) {
                return null;
              }
              const normTerm = `${term}`.trim().toLowerCase();
              const boolValue =
                normTerm === "true"
                  ? 1
                  : normTerm === "false"
                    ? 0
                    : parseInt(normTerm, 10);
              return SqlString.format(`(?? = ?)`, [identifier, boolValue]);
            }

            return null;
          })
          .filter((clause): clause is string => clause != null);

        if (clauses.length === 0) {
          return this.NOT_FOUND_QUERY;
        }

        const orClause = clauses.join(" OR ");
        const wrapped = clauses.length === 1 ? clauses[0] : `(${orClause})`;

        if (isNegatedField) {
          return `(NOT ${wrapped})`;
        }

        return wrapped;
      }

      if (column) {
        if (prefixWildcard || suffixWildcard) {
          return SqlString.format(
            `(lower(?) ${isNegatedField ? "NOT " : ""}LIKE lower(?))`,
            [
              SqlString.raw(column ?? ""),
              `${prefixWildcard ? "%" : ""}${term}${suffixWildcard ? "%" : ""}`,
            ],
          );
        } else {
          const hasSeperators = this.termHasSeperators(term);
          if (hasSeperators) {
            const tokens = this.tokenizeTerm(term);
            return `(${isNegatedField ? "NOT (" : ""}${[
              ...tokens.map((token) =>
                SqlString.format(`hasToken(lower(?), lower(?))`, [
                  SqlString.raw(column ?? ""),
                  token,
                ]),
              ),
              SqlString.format(`(lower(?) LIKE lower(?))`, [
                SqlString.raw(column ?? ""),
                `%${term}%`,
              ]),
            ].join(" AND ")}${isNegatedField ? ")" : ""})`;
          }

          return SqlString.format(
            `(${isNegatedField ? "NOT " : ""}hasToken(lower(?), lower(?)))`,
            [SqlString.raw(column ?? ""), term],
          );
        }
      }

      return this.NOT_FOUND_QUERY;
    } else {
      if (supportsTextSearch === false) {
        return this.NOT_FOUND_QUERY;
      }

      const searchTarget = column && column.length > 0 ? column : sourceColumn;
      if (!searchTarget) {
        return this.NOT_FOUND_QUERY;
      }

      const usePhrasePrefix = !isPhrase && suffixWildcard && !prefixWildcard;
      const matchTerm = isPhrase
        ? term
        : usePhrasePrefix
          ? term
          : `${prefixWildcard ? "*" : ""}${term}${suffixWildcard ? "*" : ""}`;
      const operator = isPhrase
        ? "MATCH_PHRASE"
        : usePhrasePrefix
          ? "MATCH_PHRASE_PREFIX"
          : "MATCH_ANY";
      return SqlString.format(
        `(? ${isNegatedField ? "NOT " : ""}${operator} ?)`,
        [SqlString.raw(searchTarget), matchTerm],
      );
    }
  }

  async range(
    field: string,
    start: string,
    end: string,
    isNegatedField: boolean,
  ) {
    const { column, found } = await this.getColumnForField(field);
    if (!found) {
      return this.NOT_FOUND_QUERY;
    }
    return SqlString.format(
      `(${column} ${isNegatedField ? "NOT " : ""}BETWEEN ? AND ?)`,
      [this.attemptToParseNumber(start), this.attemptToParseNumber(end)],
    );
  }
}

export type CustomSchemaConfig = {
  projectId: string;
  databaseName: string;
  implicitColumnExpression?: string;
  tableName: string;
  connectionId?: string;
  datasourceType?: string;
};

export class CustomSchemaSQLSerializerV2 extends SQLSerializer {
  private projectId: string;
  private tableName: string;
  private databaseName: string;
  private implicitColumnExpression?: string;
  private connectionId?: string;
  private datasourceType?: string;
  private legacyMetadataProvider?: LegacyMetadataProvider;
  private columnMetadataCache = new Map<string, ColumnLookup | null>();
  private invertedIndexColumns?: Set<string>;
  private invertedIndexColumnsPromise?: Promise<Set<string>>;

  constructor({
    metadata,
    projectId,
    databaseName,
    tableName,
    connectionId,
    implicitColumnExpression,
    datasourceType,
  }: { metadata?: LegacyMetadataProvider } & CustomSchemaConfig) {
    super();
    this.legacyMetadataProvider = metadata;
    this.projectId = projectId;
    this.databaseName = databaseName;
    this.tableName = tableName;
    this.implicitColumnExpression = implicitColumnExpression;
    this.connectionId = connectionId;
    this.datasourceType = datasourceType;
  }

  private async fetchColumnMetadata(
    column: string,
  ): Promise<ColumnLookup | null> {
    if (this.columnMetadataCache.has(column)) {
      return this.columnMetadataCache.get(column) ?? null;
    }

    let resolved: ColumnLookup | null = null;

    try {
      const result = await getColumnMetadata({
        projectId: this.projectId,
        connectionId: this.connectionId,
        database: this.databaseName,
        table: this.tableName,
        column,
        datasourceType: this.datasourceType,
      });

      if (result) {
        resolved = {
          name: result.name,
          type:
            result.normalizedType ||
            result.columnType ||
            result.dataType ||
            "Unknown",
          dataType: result.dataType,
          columnType: result.columnType,
        };
      }
    } catch (_error) {
      // ignore service errors and fallback to legacy metadata provider if available
    }

    if (!resolved && this.legacyMetadataProvider?.getColumn) {
      try {
        const legacy = await this.legacyMetadataProvider.getColumn({
          databaseName: this.databaseName,
          tableName: this.tableName,
          column,
          connectionId: this.connectionId,
        });

        if (legacy) {
          resolved = {
            name: legacy.name,
            type: legacy.type || "Unknown",
          };
        }
      } catch (_legacyError) {
        // swallow legacy metadata errors
      }
    }

    this.columnMetadataCache.set(column, resolved);
    return resolved;
  }

  private async loadInvertedIndexColumns(): Promise<Set<string>> {
    if (this.invertedIndexColumns) {
      return this.invertedIndexColumns;
    }

    if (!this.invertedIndexColumnsPromise) {
      this.invertedIndexColumnsPromise = (async () => {
        try {
          const columns = await getInvertedIndexColumns({
            projectId: this.projectId,
            connectionId: this.connectionId,
            database: this.databaseName,
            table: this.tableName,
            datasourceType: this.datasourceType,
          });
          return new Set(columns.map((name) => name.toLowerCase()));
        } catch (_error) {
          return new Set<string>();
        }
      })();
    }

    const resolved = await this.invertedIndexColumnsPromise;
    this.invertedIndexColumns = resolved;
    return resolved;
  }

  private async columnHasInvertedIndex(column: string): Promise<boolean> {
    if (!column) {
      return false;
    }

    const indexes = await this.loadInvertedIndexColumns();
    return indexes.has(column.toLowerCase());
  }

  private async buildColumnExpressionFromField(field: string) {
    const exactMatch = await this.fetchColumnMetadata(field);

    if (exactMatch) {
      return {
        found: true,
        columnType: exactMatch.type,
        columnExpression: exactMatch.name,
        sourceColumn: exactMatch.name,
      };
    }

    const fieldPrefix = field.split(".")[0];
    const prefixMatch = await this.fetchColumnMetadata(fieldPrefix);

    if (prefixMatch) {
      const fieldPostfix = field.split(".").slice(1).join(".");

      if (prefixMatch.type.startsWith("Map")) {
        const valueType = prefixMatch.type.match(/,\s+(\w+)\)$/)?.[1];
        return {
          found: true,
          columnExpression: SqlString.format(`??[?]`, [
            prefixMatch.name,
            fieldPostfix,
          ]),
          columnType: valueType ?? "Unknown",
          sourceColumn: prefixMatch.name,
        };
      } else if (prefixMatch.type.startsWith("JSON")) {
        return {
          found: true,
          columnExpression: "",
          columnExpressionJSON: {
            string: SqlString.format(`toString(??)`, [field]),
            number: SqlString.format(`dynamicType(??) in (?) and ??`, [
              field,
              CLICK_HOUSE_JSON_NUMBER_TYPES,
              field,
            ]),
          },
          columnType: "JSON",
          sourceColumn: prefixMatch.name,
        };
      } else if (prefixMatch.type === "String") {
        const nestedPaths = fieldPostfix.split(".");
        return {
          found: true,
          columnExpression: SqlString.format(
            `JSONExtractString(??, ${Array(nestedPaths.length).fill("?").join(",")})`,
            [prefixMatch.name, ...nestedPaths],
          ),
          columnType: "String",
          sourceColumn: prefixMatch.name,
        };
      }

      throw new Error("Unsupported column type for prefix match");
    }

    return {
      found: true,
      columnExpression: field,
      columnType: "Unknown",
      sourceColumn: field,
    };
  }

  async getColumnForField(field: string) {
    if (field === IMPLICIT_FIELD) {
      if (!this.implicitColumnExpression) {
        throw new Error(
          "Can not search bare text without an implicit column set.",
        );
      }

      const expressions = splitAndTrimWithBracket(
        this.implicitColumnExpression,
      );
      const implicitFieldCandidates = Array.from(
        new Set(
          expressions
            .reduce<string[]>((acc, expression) => {
              acc.push(...this.extractFieldNamesFromExpression(expression));
              return acc;
            }, [])
            .filter((name): name is string => !!name),
        ),
      );

      const implicitTargets: any[] = (
        await Promise.all(
          implicitFieldCandidates.map(async (candidate) => {
            try {
              const candidateExpression =
                await this.buildColumnExpressionFromField(candidate);
              const candidatePropertyType =
                convertCHTypeToPrimitiveJSType(
                  candidateExpression.columnType,
                ) ?? undefined;

              let candidateSupportsTextSearch: boolean | undefined;
              if (
                (candidatePropertyType === JSDataType.String ||
                  candidatePropertyType === JSDataType.JSON) &&
                candidateExpression.sourceColumn &&
                candidateExpression.columnExpression ===
                  candidateExpression.sourceColumn
              ) {
                candidateSupportsTextSearch = await this.columnHasInvertedIndex(
                  candidateExpression.sourceColumn,
                );
              } else if (
                candidatePropertyType === JSDataType.String ||
                candidatePropertyType === JSDataType.JSON
              ) {
                candidateSupportsTextSearch = false;
              }

              return {
                column: candidateExpression.columnExpression,
                sourceColumn: candidateExpression.sourceColumn ?? candidate,
                propertyType: candidatePropertyType,
                supportsTextSearch: candidateSupportsTextSearch,
              };
            } catch (_error) {
              return null;
            }
          }),
        )
      ).filter((target) => target !== null);

      return {
        column:
          expressions.length > 1
            ? `concatWithSeparator(';',${expressions.join(",")})`
            : this.implicitColumnExpression,
        columnJSON: undefined,
        propertyType: JSDataType.String,
        supportsTextSearch: undefined,
        sourceColumn: undefined,
        implicitTargets,
        found: true,
      };
    }

    const expression = await this.buildColumnExpressionFromField(field);
    const propertyType =
      convertCHTypeToPrimitiveJSType(expression.columnType) ?? undefined;

    let supportsTextSearch: boolean | undefined;
    if (
      (propertyType === JSDataType.String ||
        propertyType === JSDataType.JSON) &&
      expression.sourceColumn &&
      expression.columnExpression === expression.sourceColumn
    ) {
      supportsTextSearch = await this.columnHasInvertedIndex(
        expression.sourceColumn,
      );
    } else if (
      propertyType === JSDataType.String ||
      propertyType === JSDataType.JSON
    ) {
      supportsTextSearch = false;
    }

    return {
      column: expression.columnExpression,
      columnJSON: expression?.columnExpressionJSON,
      propertyType,
      supportsTextSearch,
      sourceColumn: expression.sourceColumn,
      implicitTargets: undefined,
      found: expression.found,
    };
  }

  private extractFieldNamesFromExpression(expression: string): string[] {
    const matches = expression.match(/`([^`]+)`/g);
    if (!matches) {
      return [];
    }
    return matches.map((match) => match.slice(1, -1));
  }
}
