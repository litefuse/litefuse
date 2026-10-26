import axios, { AxiosInstance } from "axios";
import { randomUUID } from "crypto";
import http from "http";
import https from "https";
import { Readable } from "stream";
import mysql from "mysql2/promise";
import { env } from "../../env";
import { getCurrentSpan } from "../instrumentation";
import { propagation, context } from "@opentelemetry/api";
import { logger } from "../logger";
import { DorisParameterProcessor } from "./parameterProcessor";
import { toLogicalTable } from "./tableRouting";

// Doris reports charset 33 (utf8) in MySQL protocol column metadata, but stores
// utf8mb4. mysql2 maps charset 33 to 'cesu8' (3-byte), so 4-byte chars (emoji)
// in string columns decode to U+FFFD ('�'). The global fix —
// require("mysql2/lib/constants/charset_encodings")[33]='utf8' — is blocked by
// mysql2's package.json "exports" map, so instead the connection typeCast below
// force-decodes string/blob columns with field.string("utf8"). See STRING_FIELD_TYPES.

// mysql2 field.type names for text/blob columns we force-decode as utf8 (Doris
// stores utf8 text in all of these; no binary blobs in our schema).
const STRING_FIELD_TYPES = new Set([
  "VARCHAR",
  "VAR_STRING",
  "STRING",
  "BLOB",
  "TINY_BLOB",
  "MEDIUM_BLOB",
  "LONG_BLOB",
  "ENUM",
  "SET",
]);

export interface DorisStreamLoadOptions {
  format?: "json" | "csv";
  columns?: string;
  jsonpaths?: string;
  strip_outer_array?: boolean;
  read_json_by_line?: boolean;
  max_filter_ratio?: number;
  timeout?: number;
  load_mem_limit?: number;
  /**
   * Caller-owned STABLE label (must be identical across retries of the same
   * batch). Supplying it opts this load into exactly-once semantics: a
   * response of "Label Already Exists" + ExistingJobStatus FINISHED is treated
   * as SUCCESS (the previous attempt committed — e.g. the client timed out
   * after the body landed), instead of a failure. Without it a per-attempt
   * label is generated and "Label Already Exists" stays a plain failure (it
   * could only be a collision). Only pass this for tables where duplicate
   * application corrupts data (AGGREGATE-KEY SUM columns); MoW unique-key
   * tables are idempotent and don't need it.
   */
  label?: string;
}

/**
 * Result of a Stream Load attempt that did not throw.
 * `dedupedByLabel: true` ⇔ this call did NOT load anything because the FE
 * label registry proved an earlier attempt of the SAME label already
 * committed (Label Already Exists + FINISHED, or SHOW TRANSACTION resolved
 * VISIBLE/COMMITTED). Callers implementing exactly-once (otel group jobs)
 * branch on this to decide replay behavior; all other outcomes — including
 * empty-input early returns and Publish Timeout — report `false`.
 */
export interface StreamLoadOutcome {
  dedupedByLabel: boolean;
}

export interface DorisQueryOptions {
  format?: "JSONEachRow" | "JSON";
  query_params?: Record<string, any>;
  timeout?: number;
}

/**
 * A pre-serialized Stream Load body delivered as byte chunks instead of one
 * string. `chunks()` must yield buffers that concatenated form the exact HTTP
 * body; `byteLength` must equal their total size — it is sent verbatim as
 * Content-Length (an overcount stalls the request until timeout, an undercount
 * aborts it mid-write). Each send calls chunks() afresh, so retries never need
 * the body to be materialized. `format` names the framing the chunks encode;
 * streamLoadBody derives the strip_outer_array/read_json_by_line flags from it
 * (overriding any caller options for those two), so a framing↔flags mismatch
 * is unrepresentable. Used by the hot ingestion path (DorisWriter) so a batch
 * is streamed row-by-row to the socket rather than concatenated into a
 * body-sized string plus a body-sized Buffer copy.
 */
export type StreamLoadBodySource = {
  format: "ndjson" | "json_array";
  chunks: () => Iterable<Buffer>;
  byteLength: number;
};

// Truncation for verbatim peer-response bodies embedded in error messages —
// enough to carry a full Stream Load result JSON (Message, ErrorURL, counts)
// without letting an HTML error page flood the log line.
const RESPONSE_LOG_MAX_CHARS = 1000;

export interface DorisClientConfig {
  feHttpUrl?: string;
  feQueryPort?: number;
  database?: string;
  username?: string;
  password?: string;
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
  headers?: Record<string, string>;
  maxOpenConnections?: number;
  maxSockets?: number;
}

export type DorisClientType = DorisClient;

/**
 * DorisClient provides HTTP-based data loading and JDBC-based querying capabilities for Apache Doris
 * Focuses on Stream Load functionality for high-performance data ingestion and MySQL protocol for queries
 */
export class DorisClient {
  private httpClient: AxiosInstance;
  // Dedicated instance for Stream Load PUTs. Shares agents + interceptors with
  // httpClient but omits the instance-level `auth` config — Stream Load callers
  // build their own Authorization header (manual 307 handling), and axios'
  // instance auth would silently overwrite it.
  private streamLoadClient: AxiosInstance;
  private httpAgent: http.Agent;
  private httpsAgent: https.Agent;
  private config: Required<DorisClientConfig>;
  private connectionPool: mysql.Pool | null = null;

  constructor(config: DorisClientConfig = {}) {
    const maxSockets =
      config.maxSockets ?? env.LITEFUSE_INGESTION_DORIS_HTTP_MAX_SOCKETS ?? 100;

    this.config = {
      feHttpUrl: config.feHttpUrl ?? env.DORIS_FE_HTTP_URL,
      feQueryPort: config.feQueryPort ?? env.DORIS_FE_QUERY_PORT,
      database: config.database ?? env.DORIS_DB,
      username: config.username ?? env.DORIS_USER ?? "root",
      password: config.password ?? env.DORIS_PASSWORD,
      timeout: config.timeout ?? env.DORIS_REQUEST_TIMEOUT_MS,
      maxRetries:
        config.maxRetries ?? env.LITEFUSE_INGESTION_DORIS_MAX_ATTEMPTS ?? 3,
      retryDelay: config.retryDelay ?? 1000,
      headers: config.headers || {},
      maxOpenConnections:
        config.maxOpenConnections ?? env.DORIS_MAX_OPEN_CONNECTIONS,
      maxSockets,
    } as Required<DorisClientConfig>;

    // keepAlive + maxFreeSockets so stream-load sockets get reused instead of
    // accumulating one TCP connection per request. socket-level timeout closes
    // half-dead connections that upstream (LB/proxy/BE) has already abandoned.
    const agentOptions = {
      maxSockets,
      keepAlive: true,
      maxFreeSockets: Math.max(8, Math.floor(maxSockets / 4)),
      timeout: 60_000,
    };
    this.httpAgent = new http.Agent(agentOptions);
    this.httpsAgent = new https.Agent(agentOptions);

    this.httpClient = axios.create({
      baseURL: this.config.feHttpUrl,
      timeout: this.config.timeout,
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      auth: {
        username: this.config.username,
        password: this.config.password,
      },
      headers: {
        "Content-Type": "application/json",
        ...this.config.headers,
      },
      // Enable automatic redirect following for Stream Load
      maxRedirects: 5,
      // Preserve auth headers on redirect
      beforeRedirect: (
        options: any,
        { headers }: { headers: Record<string, string> },
      ) => {
        if (options.auth) {
          const authString = Buffer.from(
            `${options.auth.username}:${options.auth.password}`,
          ).toString("base64");
          headers.authorization = `Basic ${authString}`;
        }
      },
    });

    // Stream Load PUTs go through a separate instance so they can inherit
    // agents + interceptors without inheriting instance-level basic auth (which
    // would clobber the manually constructed Authorization header used for the
    // FE→BE 307 dance).
    this.streamLoadClient = axios.create({
      baseURL: this.config.feHttpUrl,
      timeout: this.config.timeout,
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      // Mirror httpClient default headers so user-supplied this.config.headers
      // still flow through Stream Load just like every other Doris HTTP call.
      headers: {
        "Content-Type": "application/json",
        ...this.config.headers,
      },
    });

    // OTel + error-log interceptors apply to both clients. Hand them the same
    // function refs so behavior stays in lockstep.
    const otelInjectInterceptor = (config: any) => {
      const activeSpan = getCurrentSpan();
      if (activeSpan && config.headers) {
        propagation.inject(context.active(), config.headers);
      }
      return config;
    };
    const errorLogInterceptor = (error: any) => {
      logger.error("Doris HTTP request failed", {
        url: error.config?.url,
        method: error.config?.method,
        status: error.response?.status,
        message: error.message,
      });
      return Promise.reject(error);
    };

    this.httpClient.interceptors.request.use(otelInjectInterceptor);
    this.httpClient.interceptors.response.use(
      (response: any) => response,
      errorLogInterceptor,
    );
    this.streamLoadClient.interceptors.request.use(otelInjectInterceptor);
    this.streamLoadClient.interceptors.response.use(
      (response: any) => response,
      errorLogInterceptor,
    );

    // Initialize MySQL connection pool for queries
    this.initializeConnectionPool();
  }

  private initializeConnectionPool(): void {
    try {
      // Extract hostname from HTTP URL for MySQL connection
      const url = new URL(this.config.feHttpUrl);
      const host = url.hostname;

      const poolConfig: any = {
        host: host,
        port: this.config.feQueryPort,
        user: this.config.username,
        password: this.config.password,
        waitForConnections: true,
        connectionLimit: this.config.maxOpenConnections,
        // LITEFUSE ADDITION: mysql2 only starts its idle-connection reaper when
        // maxIdle < connectionLimit (mysql2/lib/base/pool.js). Without it a pool
        // grows to connectionLimit and holds every socket forever, so web
        // (several bundles, one pool each) + worker exhausted Doris' per-user cap
        // (`max_user_connections` = 100 for root) and every telemetry query
        // failed with "Reach limit of connections" — which surfaced as a 500 on
        // the Scores page and an empty table. Keeping a couple of warm
        // connections per pool still avoids reconnecting on every query.
        maxIdle: Math.min(2, Math.max(1, this.config.maxOpenConnections - 1)),
        idleTimeout: 60000,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        acquireTimeout: this.config.timeout,
        timeout: this.config.timeout,
        connectTimeout: this.config.timeout,
        timezone: "+00:00", // Doris stores UTC timestamps, tell mysql2 to interpret them as UTC
        // Handle JSON columns: try to parse, but return raw string on failure
        // This handles cases where Doris stores non-JSON strings in variant columns
        // (e.g., "[<truncated due to size exceeding limit>]")
        typeCast: function (field: any, next: () => any) {
          if (field.type === "JSON") {
            const str = field.string("utf8");
            if (!str) return str;
            try {
              return JSON.parse(str);
            } catch {
              logger.warn(
                `Doris typeCast: JSON.parse failed for column ${field.name}`,
                {
                  column: field.name,
                  rawValue:
                    str.substring(0, 200) + (str.length > 200 ? "..." : ""),
                  valueLength: str.length,
                },
              );
              return str;
            }
          }
          // Force utf8 decoding for string/blob columns. Doris advertises charset
          // 33 (which mysql2 decodes as 3-byte cesu8 → '�' for 4-byte emoji), but
          // its data is utf8mb4. field.string("utf8") decodes 4-byte chars correctly.
          if (STRING_FIELD_TYPES.has(field.type)) {
            return field.string("utf8");
          }
          return next();
        },
      };
      // Only add database to config if it's not empty
      if (this.config.database && this.config.database.trim() !== "") {
        poolConfig.database = this.config.database;
      }

      this.connectionPool = mysql.createPool(poolConfig);

      // Attach a pool-level 'error' listener. mysql2 emits this for
      // connection-level failures that happen OUTSIDE of a query promise —
      // e.g. handshake rejection ("Reach limit of connections"), background
      // keep-alive probe failures, server-initiated FIN on idle connections.
      // Without a listener, Node's EventEmitter treats 'error' as an
      // uncaught exception and crashes the worker process (Docker then
      // restarts the container). Logging + swallowing is safe because every
      // call path (query / commandWithParams / queryWithParams / streamLoad)
      // has its own try/catch that surfaces the failure through the Promise.
      // mysql2's public Pool.on() type only exposes 'enqueue'. The
      // underlying EventEmitter still emits 'error' for
      // connection-acquire/keep-alive failures, so we cast to attach a
      // listener. Without this, Doris rejecting a new connection
      // ("Reach limit of connections") crashes the worker process.
      (this.connectionPool as unknown as import("events").EventEmitter).on(
        "error",
        (err: unknown) => {
          logger.error("Doris MySQL pool emitted error event (swallowed)", {
            error: err instanceof Error ? err.message : String(err),
            code: (err as { code?: string } | undefined)?.code,
          });
        },
      );

      logger.debug("Doris MySQL connection pool initialized", {
        host,
        port: this.config.feQueryPort,
        database: this.config.database || "none",
      });
    } catch (error) {
      logger.error("Failed to initialize Doris MySQL connection pool", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Execute a query against Doris using MySQL protocol
   * @param queryString SQL query string
   * @param params Query parameters
   * @param options Query options
   * @returns Promise<any[]>
   */
  async query(
    queryString: string,
    params: any[] = [],
    _options: DorisQueryOptions = {},
  ): Promise<any[]> {
    if (!this.connectionPool) {
      throw new Error("MySQL connection pool not initialized");
    }

    try {
      logger.debug("Executing Doris query", {
        query:
          queryString.substring(0, 200) +
          (queryString.length > 200 ? "..." : ""),
        paramsCount: params.length,
      });

      // Use query instead of execute to avoid MySQL protocol compatibility issues with Doris
      // This fixes the "offset out of range" error when using prepared statements
      let finalQuery = queryString;
      if (params.length > 0) {
        // Manually replace ? placeholders with escaped values for basic compatibility
        params.forEach((param) => {
          const placeholder = "?";
          const escapedValue = this.escapeValue(param);
          const placeholderIndex = finalQuery.indexOf(placeholder);
          if (placeholderIndex !== -1) {
            finalQuery =
              finalQuery.substring(0, placeholderIndex) +
              escapedValue +
              finalQuery.substring(placeholderIndex + 1);
          }
        });
      }

      const queryStartTime = Date.now();
      const [rows] = await this.connectionPool.query(finalQuery);
      const queryDurationMs = Date.now() - queryStartTime;

      logger.debug("Doris query completed", {
        rowCount: Array.isArray(rows) ? rows.length : 0,
        durationMs: queryDurationMs,
      });

      // Auto-warn slow queries regardless of LITEFUSE_DORIS_LOG_QUERIES so
      // operational anomalies surface even when the per-query log is off.
      if (queryDurationMs > env.LITEFUSE_DORIS_SLOW_QUERY_THRESHOLD_MS) {
        logger.warn(`doris:slow-query (${queryDurationMs}ms) ${finalQuery}`);
      }

      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Doris query failed: ${errMsg}, SQL: ${queryString}`);
      throw error;
    }
  }

  /**
   * Simple value escaping for SQL queries (basic protection)
   * @param value The value to escape
   * @returns Escaped value as string
   */
  private escapeValue(value: any): string {
    if (value === null || value === undefined) {
      return "NULL";
    }

    // Handle arrays (for IN clauses)
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return "NULL"; // Empty array becomes NULL
      }
      // Recursively escape each array element and join with commas
      return value.map((item) => this.escapeValue(item)).join(", ");
    }

    if (typeof value === "string") {
      return `'${value.replace(/'/g, "''")}'`;
    }

    if (typeof value === "boolean") {
      return String(value);
    }

    if (typeof value === "number") {
      // Check if this looks like a millisecond timestamp (> year 2001)
      if (value > 978307200000) {
        // 2001-01-01 in milliseconds
        // Convert timestamp to Doris DateTime format
        const date = new Date(value);
        return `'${date.toISOString().replace("T", " ").replace("Z", "")}'`;
      }
      // Regular number
      return String(value);
    }

    if (value instanceof Date) {
      return `'${value.toISOString().replace("T", " ").replace("Z", "")}'`;
    }

    // For other types, convert to string and escape
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  /**
   * Execute a parameterized query with named parameters (similar to ClickHouse client interface)
   * @param options Query options with query string and parameters
   * @returns Promise with json() method for compatibility
   */
  async queryWithParams(options: {
    query: string;
    query_params?: Record<string, any>;
    format?: string;
  }): Promise<{ json(): Promise<any[]> }> {
    const { query, query_params = {} } = options;

    // Use unified parameter processor for consistency
    const processedQuery = DorisParameterProcessor.processQuery(
      query,
      query_params,
    );

    if (env.LITEFUSE_DORIS_LOG_QUERIES === "true") {
      logger.info(`doris:query ${processedQuery}`);
    } else {
      logger.debug(`doris:query ${processedQuery}`);
    }

    // Execute the processed query
    const result = await this.query(processedQuery, []);

    // Return object with json() method for compatibility with ClickHouse client
    return {
      json: async () => result,
    };
  }

  /**
   * Stream rows from a SELECT query, one at a time, with bounded memory.
   *
   * Borrows a single connection from the pool, runs the raw SQL with the
   * mysql2 callback API's `.query(sql).stream()` (the promise wrapper hides
   * `.stream()`, so we reach through `conn.connection`), and yields each row
   * as it arrives over the wire. Connection is released back to the pool in
   * the finally block whether the consumer drains the stream, breaks early,
   * or throws.
   */
  async *queryStream<T = any>(
    sql: string,
    options: { highWaterMark?: number } = {},
  ): AsyncGenerator<T> {
    if (!this.connectionPool) {
      throw new Error("MySQL connection pool not initialized");
    }

    const highWaterMark = options.highWaterMark ?? 1000;
    const startTime = Date.now();
    const conn = await this.connectionPool.getConnection();

    try {
      // mysql2/promise's PoolConnection wraps a callback Connection. The
      // promise wrapper does not expose `.stream()`, but we can reach the
      // underlying callback connection at `.connection`.
      const underlying = (conn as unknown as { connection: any }).connection;
      const stream = underlying.query(sql).stream({ highWaterMark });

      let rowCount = 0;
      for await (const row of stream) {
        rowCount++;
        yield row as T;
      }

      const durationMs = Date.now() - startTime;
      logger.debug("Doris stream query completed", {
        rowCount,
        durationMs,
      });
      if (durationMs > env.LITEFUSE_DORIS_SLOW_QUERY_THRESHOLD_MS) {
        logger.warn(
          `doris:slow-stream-query (${durationMs}ms, ${rowCount} rows) ${sql}`,
        );
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Doris stream query failed: ${errMsg}, SQL: ${sql}`);
      throw error;
    } finally {
      conn.release();
    }
  }

  /**
   * Issue the PUT used by Stream Load. Both the FE call (relative path against
   * httpClient.baseURL) and the BE redirect call (absolute URL) go through this
   * helper so they share the same keep-alive http(s).Agent — otherwise the BE
   * leg falls back to axios' default global agent, opens a brand-new TCP per
   * request, and at high ingest rate exhausts the local ephemeral port range.
   */
  private async streamLoadPut(
    urlOrPath: string,
    // Never a plain string: axios' default transformRequest "validates" a
    // string body under a JSON content type by JSON.parse-ing ALL of it
    // (stringifySafely), allocating and discarding an object graph several
    // times the body size on every attempt. Streams pass through untouched.
    data: Readable | undefined,
    authHeaders: Record<string, string>,
  ) {
    const isAbsolute = /^https?:\/\//i.test(urlOrPath);
    return this.streamLoadClient.put(urlOrPath, data, {
      headers: authHeaders,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      maxRedirects: 0,
      // Absolute URLs (BE redirect target) must not inherit the FE baseURL.
      // Pass an empty string rather than undefined; axios falls back to the
      // instance baseURL when the config value is missing.
      baseURL: isAbsolute ? "" : this.config.feHttpUrl,
      validateStatus: (status: number) => status >= 200 && status < 400,
    });
  }

  /**
   * Stream Load data into Doris table using HTTP API. Object convenience
   * wrapper — serializes `data` once and delegates to streamLoadBody. Prefer
   * streamLoadBody / insert(body, recordCount) on the hot ingestion path where
   * the caller already holds a pre-serialized body (avoids a second full
   * JSON.stringify of the batch).
   * @param table Target table name
   * @param data Array of records to insert
   * @param options Stream load options
   * @returns Promise<void>
   */
  async streamLoad<T = any>(
    table: string,
    data: T[],
    options: DorisStreamLoadOptions = {},
  ): Promise<StreamLoadOutcome> {
    if (!data || data.length === 0) {
      logger.warn("No data provided for stream load", { table });
      return { dedupedByLabel: false };
    }
    return this.streamLoadBody(
      table,
      JSON.stringify(data),
      data.length,
      options,
    );
  }

  /**
   * Stream Load a pre-serialized body. `body` is the exact bytes sent to Doris
   * (a JSON array when strip_outer_array=true, or newline-delimited objects
   * when read_json_by_line=true) — either one string or a StreamLoadBodySource
   * streamed chunk-by-chunk. `recordCount` is used only for logging.
   */
  async streamLoadBody(
    table: string,
    body: string | StreamLoadBodySource,
    recordCount: number,
    options: DorisStreamLoadOptions = {},
  ): Promise<StreamLoadOutcome> {
    if (!body) {
      logger.warn("No data provided for stream load", { table });
      return { dedupedByLabel: false };
    }

    // Normalize a string body into the chunked shape so everything downstream
    // (byte accounting, payload, headers) has exactly ONE path. A string
    // carries no framing discriminant — its flags come from options/defaults.
    const source: {
      format?: "ndjson" | "json_array";
      chunks: () => Iterable<Buffer>;
      byteLength: number;
    } =
      typeof body === "string"
        ? {
            byteLength: Buffer.byteLength(body, "utf8"),
            chunks: () => [Buffer.from(body, "utf8")],
          }
        : body;
    const bodyBytes = source.byteLength;
    // <= 0 (not === 0): a buggy producer's negative/NaN byteLength must be
    // rejected here, never sent as a malformed Content-Length header.
    if (!Number.isInteger(bodyBytes) || bodyBytes <= 0) {
      logger.warn("No data provided for stream load", { table, bodyBytes });
      return { dedupedByLabel: false };
    }

    const loadOptions = {
      format: "json",
      // Self-consistent defaults for the legacy string path: streamLoad()
      // serializes one JSON array, which pairs with strip_outer_array=true and
      // read_json_by_line=false. (Both flags true is contradictory and only
      // tolerated by Doris because a JSON.stringify array is single-line.)
      strip_outer_array: true,
      read_json_by_line: false,
      timeout: 600, // 10 minutes
      ...options,
    };
    // A chunked source names its own framing — derive the two body-shape flags
    // from it so the framing and the flags can never desync (the caller's
    // options for these two are deliberately ignored).
    if (source.format) {
      loadOptions.strip_outer_array = source.format === "json_array";
      loadOptions.read_json_by_line = source.format === "ndjson";
    }

    // A caller-owned label opts into exactly-once dedup semantics (see
    // DorisStreamLoadOptions.label). Otherwise generate a per-attempt label —
    // crypto-grade randomness: once "Label Already Exists" can mean SUCCESS
    // (stable path), a collision would silently swallow a batch, so entropy
    // must be beyond doubt for both paths.
    const stableLabel = options.label != null;
    const loadLabel =
      options.label ?? `langfuse_${table}_${Date.now()}_${randomUUID()}`;

    // Prepare request headers
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Expect: "100-continue",
      label: loadLabel,
      format: loadOptions.format,
      strip_outer_array: loadOptions.strip_outer_array.toString(),
      read_json_by_line: loadOptions.read_json_by_line.toString(),
      timeout: loadOptions.timeout.toString(),
      timezone: "UTC",
    };

    const url = `/api/${this.config.database}/${table}/_stream_load`;

    try {
      // Manual redirect handling to preserve authentication
      const authString = Buffer.from(
        `${this.config.username}:${this.config.password}`,
      ).toString("base64");
      const authHeaders = {
        ...headers,
        Authorization: `Basic ${authString}`,
      };

      // Two-stage PUT.
      //
      // Doris Stream Load always goes through an FE→307→BE redirect. FE
      // doesn't ingest the body itself; it picks a BE per request
      // (load-balancing + failover) and tells the client where to push.
      // The naive "PUT the full body to FE and follow the redirect in one
      // shot" is broken on Node.js: axios + Expect:100-continue still
      // pre-fills one TCP send buffer (~64KB) before it sees the 307, and
      // FE closes the connection right after sending the redirect — which
      // surfaces as `write EPIPE` on the client whenever bodyBytes > ~64KB.
      // Under load with multi-MB batches that's nearly every request.
      //
      // The fix: send an *empty-body* PUT to FE first (Content-Length: 0).
      // FE only needs the headers to make its BE selection, so an empty PUT
      // round-trips in a few ms and yields the same 307 with a Location
      // header — but no body bytes ever flow to FE, so EPIPE is
      // mechanically impossible. The actual data body is then PUT straight
      // to the redirected BE URL (still via streamLoadPut so it reuses the
      // keep-alive agent and doesn't open one TCP per stream load).
      // Pass `undefined` (not "") as the body so axios' JSON transform emits
      // no bytes at all — JSON.stringify("") would send a 2-byte `""`. axios
      // then sets Content-Length: 0 for us. (Don't set Content-Length
      // manually too; a duplicate header makes the peer reject with 400.)
      // Tag transport errors with WHICH leg failed and the exact target URL.
      // Without this a bare axios "timeout of 30000ms exceeded" is
      // undiagnosable — it doesn't say whether the FE probe or the body PUT
      // to the (possibly unreachable) redirect target hung. The tag is read
      // by the outer catch and prefixed into the logged/thrown message.
      const tagLeg = (e: unknown, leg: string, target: string): never => {
        if (e && typeof e === "object") {
          (e as any).streamLoadLeg = leg;
          (e as any).streamLoadTarget = target;
        }
        throw e;
      };
      const feUrl = `${this.config.feHttpUrl}${url}`;

      logger.debug("DorisClient: Sending empty-body probe PUT to FE", { url });
      const probe = await this.streamLoadPut(url, undefined, authHeaders).catch(
        (e) => tagLeg(e, "FE probe PUT", feUrl),
      );

      if (probe.status !== 307 || !probe.headers?.location) {
        // The probe didn't get the expected 307 redirect. Report the facts
        // verbatim — probed URL, received status, raw response body — and let
        // the reader judge the cause (FE-side header/auth errors, a proxy, a
        // misdirected URL, ... all surface here). No interpretation in logs.
        const data = probe.data;
        const body =
          (typeof data === "string" ? data : JSON.stringify(data)) ||
          "empty body";
        throw new Error(
          `Stream load FE probe PUT ${feUrl} returned HTTP ${probe.status} without a 307 redirect; response: ${body.slice(0, RESPONSE_LOG_MAX_CHARS)}`,
        );
      }

      // Strip embedded basic-auth credentials (Doris FE embeds user:pass@host
      // in the Location header). Supports both http:// and https://.
      const redirectUrl = probe.headers.location.replace(
        /^(https?:\/\/)[^@/]+@/,
        "$1",
      );

      logger.debug("DorisClient: Sending body PUT to BE (redirect)", {
        redirectUrl,
        bodyBytes,
      });

      // Body goes straight to the redirected BE, reusing the same keep-alive
      // agent as the FE probe so we don't open one TCP per stream load. A
      // fresh Readable per attempt; axios can't know a bare stream's length,
      // so Content-Length is set manually from byteLength (exact by the
      // source's contract). Only on this leg — the FE probe stays body-less
      // with axios' own Content-Length: 0 (a duplicate header there rejects
      // with 400).
      const response = await this.streamLoadPut(
        redirectUrl,
        Readable.from(source.chunks()),
        { ...authHeaders, "Content-Length": String(bodyBytes) },
      ).catch((e) => tagLeg(e, "BE body PUT", redirectUrl));

      // Check load result. result may be a non-object (empty 200 body, plain
      // text, a stray 3xx passed by validateStatus) — optional chaining keeps
      // the failure path reporting the VERBATIM body instead of dying on a
      // TypeError that would mask the real fact.
      const result = response.data;

      // Exactly-once handshake — ONLY for caller-owned stable labels. A prior
      // attempt of THIS batch may have committed after we timed out; the FE's
      // label registry is the authority (verified on Doris 4.0.6):
      //   ExistingJobStatus FINISHED → the txn is VISIBLE: this batch is
      //     already in Doris. Success, don't re-park (that would double-apply
      //     AGGREGATE-KEY SUM columns).
      //   ExistingJobStatus RUNNING → the earlier attempt is still in flight
      //     server-side. Throw retryable: it will resolve to FINISHED (dedup)
      //     or the txn aborts (label freed → next retry loads normally).
      //   Anything else → resolve via SHOW TRANSACTION (aborted txns free the
      //     label, so "already exists" implies PREPARE/COMMITTED/VISIBLE).
      // For generated per-attempt labels this can only be a collision → fall
      // through to the plain failure path (retry gets a fresh label).
      if (stableLabel && result?.Status === "Label Already Exists") {
        if (result.ExistingJobStatus === "FINISHED") {
          logger.info(
            `Stream load deduplicated by label (already committed): ${JSON.stringify({ table, loadLabel, message: result.Message })}`,
          );
          return { dedupedByLabel: true };
        }
        if (result.ExistingJobStatus === "RUNNING") {
          throw new Error(
            `Stream load label busy (earlier attempt still running); response: ${JSON.stringify(result).slice(0, RESPONSE_LOG_MAX_CHARS)}`,
          );
        }
        // Unknown/missing ExistingJobStatus (format drift safety net): ask the
        // FE directly instead of wedging the batch in an eternal retry loop.
        const txnStatus = await this.resolveLabelTxnStatus(loadLabel);
        if (txnStatus === "VISIBLE" || txnStatus === "COMMITTED") {
          logger.info(
            `Stream load deduplicated by label (SHOW TRANSACTION=${txnStatus}): ${JSON.stringify({ table, loadLabel })}`,
          );
          return { dedupedByLabel: true };
        }
        throw new Error(
          `Stream load label already exists, txn status ${txnStatus}; response: ${JSON.stringify(result).slice(0, RESPONSE_LOG_MAX_CHARS)}`,
        );
      }

      // Publish Timeout = the transaction IS committed (durable, cannot roll
      // back); only the visibility publish to all replicas lagged past the
      // publish timeout. FE keeps publishing in the background, so the data
      // WILL become visible. Treating this as failure would retry the batch —
      // harmless under a stable label (dedup) but a guaranteed duplicate on
      // label-less tables — so it is success by definition here.
      if (result?.Status === "Publish Timeout") {
        logger.warn(
          `Stream load committed but publish timed out (data durable, visibility lagging): ${JSON.stringify({ table, loadLabel, message: result?.Message })}`,
        );
        return { dedupedByLabel: false };
      }

      if (result?.Status !== "Success") {
        // BE answered but did not accept the load. Report the response
        // verbatim — it already carries Message, ErrorURL, filtered-row
        // counts, txn info — instead of picking fields case by case. The
        // outer catch logs it exactly once.
        const body =
          (typeof result === "string" ? result : JSON.stringify(result)) ||
          "empty body";
        throw new Error(
          `Stream load Status != Success; response: ${body.slice(0, RESPONSE_LOG_MAX_CHARS)}`,
        );
      }

      if (env.LITEFUSE_DORIS_LOG_STREAM_LOAD_RESPONSE === "true") {
        logger.info(
          `Stream load completed ${JSON.stringify({ table, ...result })}`,
        );
      } else {
        logger.debug("Stream load completed", {
          table,
          recordCount,
          dataSizeKB: (bodyBytes / 1024).toFixed(2),
          loadLabel,
          response: result,
        });
      }
      return { dedupedByLabel: false };
    } catch (error) {
      // Build the failure message from FACTS only, verbatim: HTTP status +
      // raw response body when the peer answered, the transport error message
      // when it didn't. No field-picking, no interpretation.
      let errorMessage = "Unknown error";

      if (error && typeof error === "object" && "response" in error) {
        // Axios HTTP error with response
        const axiosError = error as any;
        if (axiosError.response?.data) {
          const d = axiosError.response.data;
          const body =
            (typeof d === "string" ? d : JSON.stringify(d)) || "empty body";
          errorMessage = `HTTP ${axiosError.response.status} ${axiosError.response.statusText ?? ""}; response: ${body.slice(0, RESPONSE_LOG_MAX_CHARS)}`;
        } else {
          errorMessage = axiosError.message || "Network error";
        }
      } else if (error instanceof Error) {
        errorMessage = error.message;
      } else {
        errorMessage = String(error);
      }

      // Prefix which leg failed (FE probe vs BE body PUT) + the exact target
      // URL + the axios error code (ECONNABORTED/ECONNREFUSED/EPIPE/...), set
      // by tagLeg above. A bare "timeout of 30000ms exceeded" is useless; the
      // same timeout tagged "[BE body PUT http://172.29.0.3:8040/... ]" points
      // straight at an unreachable redirect target.
      const anyErr = error as any;
      const legPrefix = anyErr?.streamLoadLeg
        ? `[${anyErr.streamLoadLeg} ${anyErr.streamLoadTarget}${anyErr?.code ? ` ${anyErr.code}` : ""}] `
        : "";
      const finalMessage = `${legPrefix}${errorMessage}`;

      // Inline errorMessage into the message string so it survives the
      // default text log format (which drops the metadata object). Without
      // this, "[E-217]json body size ... exceed BE's conf
      // streaming_load_json_max_mb ..." and similar BE-side rejections are
      // invisible until operators flip LITEFUSE_LOG_FORMAT=json. Size was
      // computed once up front (no re-scan of the body).
      const dataSizeKB = (bodyBytes / 1024).toFixed(2);
      logger.error(
        `Stream load failed for ${table} (loadLabel=${loadLabel}, recordCount=${recordCount}, dataSizeKB=${dataSizeKB}): ${finalMessage}`,
      );

      throw new Error(finalMessage);
    }
  }

  /**
   * Resolve a load label's transaction status straight from the FE (MySQL
   * protocol) — the fallback for a "Label Already Exists" response whose
   * ExistingJobStatus we can't interpret. Returns the raw TransactionStatus
   * (VISIBLE/COMMITTED/PREPARE/...) or "UNKNOWN" when the lookup itself fails —
   * callers treat non-VISIBLE/COMMITTED as retryable, so an FE hiccup here just
   * means one more backoff round, never a wrong success.
   */
  private async resolveLabelTxnStatus(label: string): Promise<string> {
    try {
      const rows = await this.query(
        `SHOW TRANSACTION FROM ${this.config.database} WHERE LABEL = '${label.replace(/'/g, "''")}'`,
      );
      // A label freed by an ABORTED txn can be reused, so the transaction
      // history may hold SEVERAL rows for the same label (e.g. an old ABORTED
      // attempt plus the later committed one) and the FE's return order
      // carries no contract. Scan ALL rows: any committed/visible txn under
      // this label means the batch IS in Doris.
      let fallback: string = "UNKNOWN";
      for (const row of rows ?? []) {
        const status = row?.TransactionStatus;
        if (typeof status !== "string" || status.length === 0) continue;
        if (status === "VISIBLE" || status === "COMMITTED") return status;
        fallback = status;
      }
      return fallback;
    } catch (e) {
      logger.warn(
        `SHOW TRANSACTION lookup failed for label ${label}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return "UNKNOWN";
    }
  }

  /**
   * Single-attempt Stream Load of a pre-serialized body. Retry/backoff is NOT
   * done here — it is owned entirely by the caller (DorisWriter re-queues failed
   * rows), so retry logic lives in exactly one layer. Throws on failure.
   * @param table Target table name
   * @param body Pre-serialized Stream Load body (JSONL or JSON array), as one
   *   string or a StreamLoadBodySource streamed chunk-by-chunk
   * @param recordCount Number of rows in `body` (logging only)
   * @param options Stream load options
   * @returns StreamLoadOutcome (dedupedByLabel — see type doc)
   */
  async insert(
    table: string,
    body: string | StreamLoadBodySource,
    recordCount: number,
    options: DorisStreamLoadOptions = {},
  ): Promise<StreamLoadOutcome> {
    return await this.streamLoadBody(table, body, recordCount, options);
  }

  /**
   * Health check for Doris FE connection
   * @returns Promise<boolean>
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.httpClient.get("/api/health");
      return response.status === 200;
    } catch (error) {
      logger.error("Doris health check failed", { error });
      return false;
    }
  }

  /**
   * Get database information
   * @returns Promise<any>
   */
  async getDatabaseInfo(): Promise<any> {
    try {
      const response = await this.httpClient.get(
        `/api/${this.config.database}`,
      );
      return response.data;
    } catch (error) {
      logger.error("Failed to get database info", { error });
      throw error;
    }
  }

  /**
   * Close the client connection and MySQL connection pool
   */
  async close(): Promise<void> {
    if (this.connectionPool) {
      await this.connectionPool.end();
      this.connectionPool = null;
      logger.debug("Doris MySQL connection pool closed");
    }
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
    logger.debug("Doris client closed");
  }
}

/**
 * DorisClientManager provides a singleton pattern for managing Doris clients.
 * It creates and reuses clients based on their configuration to avoid creating
 * a new connection for each operation.
 */
export class DorisClientManager {
  private static instance: DorisClientManager;
  private clientMap: Map<string, DorisClientType> = new Map();

  /**
   * Private constructor to enforce singleton pattern
   */
  private constructor() {}

  /**
   * Get the singleton instance of the DorisClientManager
   */
  public static getInstance(): DorisClientManager {
    if (!DorisClientManager.instance) {
      DorisClientManager.instance = new DorisClientManager();
    }
    return DorisClientManager.instance;
  }

  /**
   * Generate a consistent hash key for client configurations
   * @param config Client configuration
   * @returns String hash key
   */
  private generateClientKey(config: DorisClientConfig): string {
    const keyParams = {
      feHttpUrl: config.feHttpUrl ?? env.DORIS_FE_HTTP_URL,
      database: config.database ?? env.DORIS_DB,
      username: config.username ?? env.DORIS_USER,
      timeout: config.timeout ?? env.DORIS_REQUEST_TIMEOUT_MS,
      headers: config.headers,
    };
    return JSON.stringify(keyParams);
  }

  /**
   * Get or create a client based on the provided configuration
   * @param config Client configuration
   * @returns Doris client instance
   */
  public getClient(config: DorisClientConfig = {}): DorisClientType {
    const key = this.generateClientKey(config);

    if (!this.clientMap.has(key)) {
      const client = new DorisClient(config);
      this.clientMap.set(key, client);
    }

    return this.clientMap.get(key)!;
  }

  /**
   * Close all client connections - useful for application shutdown
   */
  public async closeAllConnections(): Promise<void> {
    const closePromises = Array.from(this.clientMap.values()).map((client) =>
      client.close(),
    );
    this.clientMap.clear();
    await Promise.all(closePromises);
  }
}

/**
 * Factory function to get a Doris client instance
 * @param config Optional client configuration
 * @returns Doris client instance
 */
export const dorisClient = (config?: DorisClientConfig): DorisClientType => {
  return DorisClientManager.getInstance().getClient(config || {});
};

// Configuration for datetime field handling
const TIMESTAMP_FIELDS = [
  "timestamp",
  "created_at",
  "updated_at",
  "event_ts",
  "start_time",
  "end_time",
  "completion_start_time",
  "dataset_run_created_at",
  "dataset_item_version",
] as const;

// null = "this table needs NO derived date field" (still must be listed —
// an unknown table name falls to the dual-column fallback branch, which would
// synthesize stray timestamp_date/start_time_date fields).
const DATE_FIELD_MAPPINGS: Record<
  string,
  { sourceField: string; dateField: string } | null
> = {
  traces: { sourceField: "timestamp", dateField: "timestamp_date" },
  scores: { sourceField: "timestamp", dateField: "timestamp_date" },
  observations: { sourceField: "start_time", dateField: "start_time_date" },
  // spans partitions directly on start_time (date_trunc auto partition,
  // migration 0037) — there is no start_time_date column to derive.
  spans: null,
  // traces_scalar also partitions directly on start_time (migration 0039) — no
  // start_time_date mirror column to derive.
  traces_scalar: null,
  // trace_metrics_agg is a sync MV on spans (migration 0040) — never
  // stream-loaded directly, so no mapping entry.
};

/**
 * Convert various timestamp formats to Date object
 */
const parseTimestamp = (value: unknown): Date | null => {
  if (!value) return null;

  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string") {
    // Handle ISO format or space-separated datetime strings
    if (value.includes("T") || value.includes(" ")) {
      // Ensure timezone-less datetime strings (e.g. "2026-04-01 06:59:08.264"
      // from ClickHouse format) are interpreted as UTC, not local time.
      let normalized = value;
      if (
        /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(value) &&
        !value.endsWith("Z") &&
        !/[+-]\d{2}(:\d{2})?$/.test(value)
      ) {
        normalized = value.replace(" ", "T") + "Z";
      }
      const date = new Date(normalized);
      return isNaN(date.getTime()) ? null : date;
    }
    // Handle millisecond timestamp strings
    const parsed = parseInt(value);
    return parsed > 0 ? new Date(parsed) : null;
  }

  return null;
};

/**
 * Normalize field value for Doris compatibility
 */
const normalizeValue = (key: string, value: unknown): unknown => {
  // Convert undefined to null
  if (value === undefined) return null;

  // Handle arrays - empty arrays become null
  if (Array.isArray(value)) return value.length > 0 ? value : null;

  // Handle Date objects - convert to ISO string
  if (value instanceof Date) return value.toISOString();

  // Handle timestamp fields - convert to ISO string
  if (TIMESTAMP_FIELDS.includes(key as any) && value != null) {
    const date = parseTimestamp(value);
    return date ? date.toISOString() : value;
  }

  return value;
};

/**
 * Generate date field from timestamp field
 */
const generateDateField = (
  record: Record<string, any>,
  sourceField: string,
  dateField: string,
): void => {
  if (record[sourceField] && !record[dateField]) {
    try {
      const date = parseTimestamp(record[sourceField]);
      if (date) {
        // Let Doris handle timezone conversion automatically for Date fields
        record[dateField] = date.toISOString();
      }
    } catch (error) {
      logger.warn(`Failed to generate ${dateField} from ${sourceField}`, {
        sourceField,
        value: record[sourceField],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};

/**
 * Parse JSON string values in metadata to native JS objects/arrays.
 *
 * Doris has a bug in its MAP<TEXT, TEXT> JSON parser: it doesn't properly
 * handle escape characters. When a metadata value is a JSON-encoded string
 * like "{\"key\":\"val\"}", the outer JSON.stringify for the stream load
 * body produces nested \" escape sequences that confuse Doris's MAP parser.
 *
 * By parsing these values to native objects BEFORE JSON.stringify(data),
 * the outer serialization produces clean nested JSON with no \" escaping:
 *
 *   Before: { "resourceAttributes": "{\"service.name\":\"foo\"}" }
 *           → outer JSON.stringify adds escaping → Doris MAP parser fails
 *
 *   After:  { "resourceAttributes": {"service.name": "foo"} }
 *           → outer JSON.stringify produces nested JSON, zero \" sequences
 *           → Doris MAP parser accepts the nested object, stores as TEXT
 *           → query returns original structure unchanged
 */
const normalizeMetadataForDoris = (
  metadata: Record<string, unknown> | undefined | null,
): Record<string, unknown> => {
  if (!metadata || typeof metadata !== "object") return {};

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (value == null || value === "") {
      result[key] = value ?? "";
      continue;
    }

    // Non-string values (nested objects/arrays/numbers — the VARIANT/spans
    // & traces_scalar case) are already native JSON; pass them through untouched.
    if (typeof value !== "string") {
      result[key] = value;
      continue;
    }

    // String values (legacy MAP<String,String> tables like scores): parse JSON
    // strings (objects and arrays) to native values so the outer JSON.stringify
    // produces genuinely nested JSON, not \"-escaped strings.
    if ((value.startsWith("{") || value.startsWith("[")) && value.length > 0) {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }

  return result;
};

/**
 * Elegant utility function to format data for Doris insertion
 * Handles data type conversion, null values, and date field generation
 */
/**
 * Normalize + date-derive a single record for Doris. Hot path: the ingestion
 * writer calls this once per row at enqueue time (so the row is serialized
 * exactly once and never re-formatted on flush/retry), rather than
 * re-formatting the whole batch on every Stream Load attempt.
 */
export const formatRecordForDoris = <T extends Record<string, any>>(
  record: T,
  tableName?: string,
): T => {
  // Step 1: Normalize all field values
  const formatted = Object.entries(record).reduce((acc, [key, value]) => {
    (acc as any)[key] = normalizeValue(key, value);
    return acc;
  }, {} as T);

  // Step 1.5: Normalize metadata to avoid Doris MAP parsing issues with
  // escaped quotes in JSON string values.
  if ("metadata" in formatted && formatted.metadata) {
    (formatted as any).metadata = normalizeMetadataForDoris(formatted.metadata);
  }

  // Step 2: Generate date fields based on table type. A listed table with a
  // null mapping (spans) needs no derived date field; only UNKNOWN
  // tables fall to the dual-column fallback.
  //
  // DATE_FIELD_MAPPINGS is keyed on LOGICAL table names. Under table split the
  // writer targets physical names (spans_<pid>), which are absent from
  // the map and would fall to the dual-column fallback — injecting stray
  // timestamp_date/start_time_date columns that spans has no slot for
  // (dirty write). toLogicalTable reverses the projectId suffix first; it is
  // identity for the shared logical names, so mode=none is unaffected.
  const logicalTable = tableName ? toLogicalTable(tableName) : undefined;
  if (logicalTable && logicalTable in DATE_FIELD_MAPPINGS) {
    const mapping = DATE_FIELD_MAPPINGS[logicalTable];
    if (mapping) {
      generateDateField(formatted, mapping.sourceField, mapping.dateField);
    }
  } else {
    // Fallback: generate both possible date fields
    generateDateField(formatted, "timestamp", "timestamp_date");
    generateDateField(formatted, "start_time", "start_time_date");
  }

  return formatted;
};

export const formatDataForDoris = <T extends Record<string, any>>(
  data: T[],
  tableName?: string,
): T[] => data.map((record) => formatRecordForDoris(record, tableName));
