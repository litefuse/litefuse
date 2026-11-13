import {
  discoverDatabase,
  DiscoverQueryError,
  discoverTableScope,
  quoteIdentifier,
} from "./queryUtils";

const CLAUSES = new Set([
  "SELECT",
  "WITH",
  "FROM",
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "UNION",
  "JOIN",
  "ON",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
]);
const UNSUPPORTED = new Set([
  "INTO",
  "OUTFILE",
  "FOR",
  "LATERAL",
  "USING",
  "INTERSECT",
  "EXCEPT",
  "MINUS",
]);
const EXPRESSION_WORDS = new Set([
  "AS",
  "ALL",
  "DISTINCT",
  "ASC",
  "DESC",
  "NULLS",
  "FIRST",
  "LAST",
  "TRUE",
  "FALSE",
  "NULL",
  "AND",
  "OR",
  "NOT",
  "IS",
  "IN",
  "BETWEEN",
  "LIKE",
  "REGEXP",
  "RLIKE",
  "ESCAPE",
  "EXISTS",
  "MATCH",
  "MATCH_ALL",
  "MATCH_ANY",
  "MATCH_PHRASE",
  "MATCH_PHRASE_PREFIX",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "BOOLEAN",
  "TINYINT",
  "SMALLINT",
  "INT",
  "INTEGER",
  "BIGINT",
  "LARGEINT",
  "FLOAT",
  "DOUBLE",
  "DECIMAL",
  "DATE",
  "DATETIME",
  "TIMESTAMP",
  "CHAR",
  "VARCHAR",
  "STRING",
  "TEXT",
  "JSON",
  "VARIANT",
  "ARRAY",
  "MAP",
]);
const FUNCTIONS = new Set([
  "ABS",
  "ARRAY_CONTAINS",
  "ARRAY_JOIN",
  "ARRAY_MAP",
  "AVG",
  "CAST",
  "COALESCE",
  "COLLECT_SET",
  "CONCAT",
  "COUNT",
  "DATE_FORMAT",
  "IF",
  "IFNULL",
  "JSON_EXTRACT",
  "JSON_OBJECT",
  "LENGTH",
  "LOWER",
  "MAP_KEYS",
  "MAP_VALUES",
  "MAX",
  "MIN",
  "NULLIF",
  "ROUND",
  "ROW_NUMBER",
  "SUM",
  "UNIX_TIMESTAMP",
  "UPPER",
  "CHAR",
  "VARCHAR",
  "DECIMAL",
  "DATETIME",
  "SECOND_FLOOR",
  "MINUTE_FLOOR",
  "HOUR_FLOOR",
  "DAY_FLOOR",
  "WEEK_FLOOR",
  "MONTH_FLOOR",
  "QUARTER_FLOOR",
  "YEAR_FLOOR",
]);
// These keywords can be followed by a parenthesized expression.
const GROUPING_WORDS = new Set([
  "AND",
  "OR",
  "NOT",
  "IN",
  "BETWEEN",
  "EXISTS",
  "WHEN",
  "THEN",
  "ELSE",
  "DISTINCT",
  "ALL",
  "LIKE",
  "REGEXP",
  "RLIKE",
  "MATCH",
  "MATCH_ALL",
  "MATCH_ANY",
  "MATCH_PHRASE",
  "MATCH_PHRASE_PREFIX",
]);
const JOIN_TYPES = new Set(["INNER", "LEFT", "RIGHT", "FULL", "CROSS"]);

type Token = {
  kind: "word" | "identifier" | "string" | "number" | "symbol";
  text: string;
};

function unsupportedQuery(): never {
  throw new DiscoverQueryError(
    "Discover requires a single supported SELECT query",
  );
}

const TOKEN_PATTERN = [
  /[ \t\r\n]+/.source,
  /(--|\/\*|\*\/|#)/.source,
  /(`(?:``|[^`\\\x00-\x1f])*`)/.source,
  /('(?:''|\\[\s\S]|[^'\\])*'|"(?:""|\\[\s\S]|[^"\\])*")/.source,
  /((?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?![\w$])/.source,
  /([A-Za-z_][\w$]*)/.source,
  /(<=>|<>|<=|>=|!=|==|!<|!>|->|\|\||&&|[(),.;\[\]+*/%=<>!&|^~-])/.source,
].join("|");

function tokenize(sql: string): Token[] {
  if (sql.length > 65_536 || sql.includes("\0")) unsupportedQuery();
  const pattern = new RegExp(TOKEN_PATTERN, "y");
  const tokens: Token[] = [];
  let depth = 0;
  while (pattern.lastIndex < sql.length) {
    const match = pattern.exec(sql);
    if (!match || match[1]) unsupportedQuery();
    const [text, , identifier, string, number, word, symbol] = match;
    if (identifier) tokens.push({ kind: "identifier", text });
    if (string) tokens.push({ kind: "string", text });
    if (number) tokens.push({ kind: "number", text });
    if (word) tokens.push({ kind: "word", text });
    if (symbol) {
      if (symbol === "(" || symbol === "[") depth++;
      if (symbol === ")" || symbol === "]") depth--;
      if (depth < 0 || depth > 32) unsupportedQuery();
      tokens.push({ kind: "symbol", text });
    }
  }
  if (depth !== 0) unsupportedQuery();
  return tokens;
}

function identifierName(token: Token | undefined): string {
  if (token?.kind === "word") return token.text;
  if (token?.kind === "identifier") {
    return token.text.slice(1, -1).replace(/``/g, "`");
  }
  return unsupportedQuery();
}

// Rebuild the statement from parsed clauses and authorized relations. Only the
// expression vocabulary below is emitted as bare SQL. Other words are quoted
// as identifiers, so Doris extensions cannot introduce new clauses or sources.
class ReadQuery {
  private position = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly database: string,
    private readonly projectId: string,
  ) {}

  compile(): string {
    if (this.take("USE")) {
      discoverDatabase(this.identifier());
      this.expect(";");
    }
    const sql = this.query(new Set());
    this.take(";");
    if (this.tokens[this.position]) unsupportedQuery();
    return sql;
  }

  private peek(): string {
    const token = this.tokens[this.position];
    if (token?.kind === "word") return token.text.toUpperCase();
    return token?.kind === "symbol" ? token.text : "";
  }

  private take(value: string): boolean {
    if (this.peek() !== value) return false;
    this.position++;
    return true;
  }

  private expect(value: string) {
    if (!this.take(value)) unsupportedQuery();
  }

  private identifier(): string {
    return identifierName(this.tokens[this.position++]);
  }

  private query(inheritedCtes: ReadonlySet<string>): string {
    const ctes = new Set(inheritedCtes);
    const parts: string[] = [];
    if (this.take("WITH")) {
      const definitions: string[] = [];
      do {
        const name = this.identifier();
        this.expect("AS");
        this.expect("(");
        const query = this.query(ctes);
        this.expect(")");
        definitions.push(`${quoteIdentifier(name)} AS (${query})`);
        ctes.add(name);
      } while (this.take(","));
      parts.push(`WITH ${definitions.join(", ")}`);
    }

    parts.push(this.select(ctes));
    while (this.take("UNION")) {
      const modifier = this.take("ALL")
        ? " ALL"
        : this.take("DISTINCT")
          ? " DISTINCT"
          : "";
      parts.push(`UNION${modifier} ${this.select(ctes)}`);
    }
    if (this.take("ORDER")) {
      this.expect("BY");
      parts.push(`ORDER BY ${this.expression(ctes)}`);
    }
    if (this.take("LIMIT")) {
      const count = this.integer();
      if (this.take("OFFSET"))
        parts.push(`LIMIT ${count} OFFSET ${this.integer()}`);
      else if (this.take(",")) parts.push(`LIMIT ${count}, ${this.integer()}`);
      else parts.push(`LIMIT ${count}`);
    }
    return parts.join(" ");
  }

  private integer(): string {
    const token = this.tokens[this.position++];
    if (token?.kind !== "number" || !/^\d+$/.test(token.text))
      unsupportedQuery();
    return token.text;
  }

  private select(ctes: ReadonlySet<string>): string {
    this.expect("SELECT");
    const parts = ["SELECT", this.expression(ctes)];
    if (this.take("FROM")) {
      parts.push("FROM", this.relation(ctes));
      while (true) {
        if (this.take(",")) {
          parts.push(",", this.relation(ctes));
          continue;
        }
        const joinType = this.peek();
        if (JOIN_TYPES.has(joinType)) {
          this.position++;
          parts.push(joinType);
          if (this.take("OUTER")) parts.push("OUTER");
          this.expect("JOIN");
        } else if (!this.take("JOIN")) {
          break;
        }
        parts.push("JOIN", this.relation(ctes));
        if (this.take("ON")) parts.push("ON", this.expression(ctes, true));
      }
    }
    if (this.take("WHERE")) parts.push("WHERE", this.expression(ctes));
    if (this.take("GROUP")) {
      this.expect("BY");
      parts.push("GROUP BY", this.expression(ctes));
    }
    if (this.take("HAVING")) parts.push("HAVING", this.expression(ctes));
    return parts.join(" ");
  }

  private relation(ctes: ReadonlySet<string>): string {
    if (this.take("(")) {
      const query = this.query(ctes);
      this.expect(")");
      const alias = this.alias();
      if (alias === undefined) unsupportedQuery();
      return `(${query}) AS ${quoteIdentifier(alias)}`;
    }

    let table = this.identifier();
    const qualified = this.take(".");
    if (qualified) {
      let database = table;
      table = this.identifier();
      if (this.take(".")) {
        if (database !== "internal") {
          throw new DiscoverQueryError(
            "Catalog is unavailable in Discover",
            "FORBIDDEN",
          );
        }
        database = table;
        table = this.identifier();
      }
      discoverDatabase(database);
    }
    if (this.peek() === "(") unsupportedQuery();
    const alias = this.alias();
    const aliasSql = alias === undefined ? "" : ` AS ${quoteIdentifier(alias)}`;

    if (!qualified && ctes.has(table)) return quoteIdentifier(table) + aliasSql;

    const scope = discoverTableScope(this.projectId, table);
    if (!scope) {
      throw new DiscoverQueryError(
        "Table is unavailable in Discover",
        "FORBIDDEN",
      );
    }

    const source = `\`internal\`.${quoteIdentifier(this.database)}.${quoteIdentifier(table)}`;
    if (scope === "split") return source + aliasSql;

    // Scope each shared table before joins, aggregation, or caller predicates.
    // The project ID is also used for split-table routing and is identifier-safe.
    if (!/^[A-Za-z0-9_]+$/.test(this.projectId)) unsupportedQuery();
    return `(SELECT * FROM ${source} WHERE project_id = '${this.projectId}') AS ${quoteIdentifier(alias ?? table)}`;
  }

  private alias(): string | undefined {
    if (this.take("AS")) return this.identifier();
    const token = this.tokens[this.position];
    if (
      token?.kind === "identifier" ||
      (token?.kind === "word" &&
        !CLAUSES.has(this.peek()) &&
        !UNSUPPORTED.has(this.peek()))
    ) {
      return this.identifier();
    }
  }

  private expression(
    ctes: ReadonlySet<string>,
    stopAtComma = false,
    allowEmpty = false,
  ): string {
    const parts: string[] = [];
    while (this.tokens[this.position]) {
      const key = this.peek();
      if (
        CLAUSES.has(key) ||
        key === ";" ||
        key === ")" ||
        key === "]" ||
        (stopAtComma && key === ",")
      )
        break;
      if (UNSUPPORTED.has(key)) unsupportedQuery();

      const token = this.tokens[this.position++];
      if (key === "(") {
        const inner =
          this.peek() === "SELECT" || this.peek() === "WITH"
            ? this.query(ctes)
            : this.expression(ctes, false, true);
        this.expect(")");
        parts.push(`(${inner})`);
      } else if (key === "[") {
        const inner = this.expression(ctes);
        this.expect("]");
        parts.push(`[${inner}]`);
      } else if (key === "OVER") {
        if (!parts.at(-1)?.endsWith(")")) unsupportedQuery();
        parts.push(this.window(ctes));
      } else if (token.kind === "word" || token.kind === "identifier") {
        if (this.peek() === "(") {
          if (
            parts.at(-1) === "." ||
            (!FUNCTIONS.has(key) && !GROUPING_WORDS.has(key))
          ) {
            unsupportedQuery();
          }
          parts.push(token.text);
        } else {
          parts.push(
            EXPRESSION_WORDS.has(key)
              ? token.text
              : quoteIdentifier(identifierName(token)),
          );
        }
      } else if (token.kind === "string") {
        // Keep delimiters unambiguous under either Doris backslash-escape mode.
        parts.push(
          token.text.replace(/\\([\s\S])/g, (escape, char: string) =>
            char === token.text[0] ? char.repeat(2) : escape,
          ),
        );
      } else {
        parts.push(token.text);
      }
    }
    if (!allowEmpty && parts.length === 0) unsupportedQuery();
    return parts.join(" ");
  }

  private window(ctes: ReadonlySet<string>): string {
    this.expect("(");
    const clauses: string[] = [];
    if (this.take("PARTITION")) {
      this.expect("BY");
      clauses.push(`PARTITION BY ${this.expression(ctes)}`);
    }
    if (this.take("ORDER")) {
      this.expect("BY");
      clauses.push(`ORDER BY ${this.expression(ctes)}`);
    }
    this.expect(")");
    return `OVER (${clauses.join(" ")})`;
  }
}

export function prepareDiscoverRead(
  projectId: string,
  rawSql: string,
  requestedDb?: string,
) {
  const database = discoverDatabase(requestedDb);
  const sql = new ReadQuery(tokenize(rawSql), database, projectId).compile();
  return { database, sql };
}
