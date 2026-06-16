import axios, { AxiosInstance } from "axios";
import http from "http";
import https from "https";
import mysql from "mysql2/promise";
import { env } from "../../env";
import { getCurrentSpan } from "../instrumentation";
import { propagation, context } from "@opentelemetry/api";
import { logger } from "../logger";
import { DorisParameterProcessor } from "./parameterProcessor";

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
   * When true, send `partial_columns:true` to the Stream Load endpoint so
   * Doris only updates the columns listed in `columns` and preserves the
   * remaining columns on the target row (Unique Key + MoW required).
   */
  partial_columns?: boolean;
  /**
   * Behavior when partial column update targets a key that does not exist
   * yet. Doris 4.0+ defaults to APPEND (insert with defaults/null for the
   * unmentioned columns); set explicitly when targeting older releases or
   * to override the cluster default.
   */
  partial_update_new_key_behavior?: "APPEND" | "ERROR";
  /**
   * Doris Group Commit mode.
   *
   * - `sync_mode` — Doris attaches this Stream Load to the current group
   *   commit batch and the HTTP request returns only after that batch
   *   commits. This is the mode the web direct-write path uses so it can
   *   ack the SDK only once data is durable in Doris. Typical batch
   *   window is 10s / 128MB (Doris-side `group_commit_interval_ms` /
   *   `group_commit_data_bytes`); the ack latency under it is on the
   *   order of tens to ~100ms.
   * - `async_mode` — Doris persists the rows to WAL and returns
   *   immediately. Trades a small data-loss window (BE down before WAL
   *   replay) for the lowest possible ack latency. Not used today.
   * - `off_mode` — bypass group commit entirely. Default if header
   *   omitted.
   *
   * Note: Doris currently disallows group_commit when `partial_columns`
   * is also set, so callers must choose between partial column update
   * and group commit; the web direct-write path uses group commit
   * sync_mode without partial columns (every row carries its full set
   * of touched columns inside the Stream Load body).
   */
  group_commit?: "sync_mode" | "async_mode" | "off_mode";
  /**
   * Per-load `group_commit_interval_ms` override (Doris Stream Load
   * header). Only meaningful when `group_commit` is also set. When
   * present, overrides the table-level setting for this load only.
   * Caller is expected to read the value from env so ops can tune
   * visibility latency without re-deploying.
   */
  group_commit_interval_ms?: number;
  /**
   * Per-load `group_commit_data_bytes` override (Doris Stream Load
   * header). Only meaningful when `group_commit` is also set. When
   * present, overrides the table-level setting for this load only.
   * Reaching either this byte cap or the interval triggers a commit.
   */
  group_commit_data_bytes?: number;
}

export interface DorisQueryOptions {
  format?: "JSONEachRow" | "JSON";
  query_params?: Record<string, any>;
  timeout?: number;
}

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
// 400-class rejections from Doris that won't ever succeed on retry.
// `INVALID_ARGUMENT` covers most header / payload-shape mismatches;
// `[ANALYSIS_ERROR]` and `[INTERNAL_ERROR]` are 4xx-ish too. Conservative
// list — anything not matched falls back to retry (network blips, BE
// transient errors, etc).
const NON_RETRYABLE_PATTERNS = [/\[INVALID_ARGUMENT\]/i, /\[ANALYSIS_ERROR\]/i];

const isNonRetryableStreamLoadError = (err: Error): boolean => {
  const msg = err.message ?? "";
  return NON_RETRYABLE_PATTERNS.some((re) => re.test(msg));
};

export class DorisClient {
  private httpClient: AxiosInstance;
  private config: Required<DorisClientConfig>;
  private connectionPool: mysql.Pool | null = null;
  // Number of `insert()` calls currently in flight (the retry-aware
  // public Stream Load entry point). Used by graceful shutdown to wait
  // for outstanding writes to finish before tearing down connections.
  private _inflightInserts = 0;
  // True when this Doris FE ingests Stream Load inline (single-node /
  // FE-is-the-load-entrypoint deployments) instead of issuing the
  // FE→307→BE redirect. Detected on the first load and cached so later
  // loads skip the empty-body probe (which otherwise commits a 0-row txn
  // each time).
  private feIngestsInline = false;

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

    // keepAlive on this agent is intentional and limited to the FE.
    // `this.httpClient` only targets the FE; the FE is the coordinator
    // and not subject to per-load BE failover, so reusing FE sockets is
    // safe and avoids rebuilding TCP on every stream load. The BE leg
    // still uses a raw `axios.put(redirectUrl, …)` (does not go through
    // this agent), preserving the "fresh BE selection per load"
    // guarantee Doris relies on for BE load balancing.
    const httpAgent = new http.Agent({
      maxSockets,
      keepAlive: true,
      keepAliveMsecs: 30_000,
    });
    const httpsAgent = new https.Agent({
      maxSockets,
      keepAlive: true,
      keepAliveMsecs: 30_000,
    });

    this.httpClient = axios.create({
      baseURL: this.config.feHttpUrl,
      timeout: this.config.timeout,
      httpAgent,
      httpsAgent,
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

    // Add request interceptor for OpenTelemetry tracing
    this.httpClient.interceptors.request.use((config: any) => {
      const activeSpan = getCurrentSpan();
      if (activeSpan && config.headers) {
        propagation.inject(context.active(), config.headers);
      }
      return config;
    });

    // Add response interceptor for error handling
    this.httpClient.interceptors.response.use(
      (response: any) => response,
      (error: any) => {
        logger.error("Doris HTTP request failed", {
          url: error.config?.url,
          method: error.config?.method,
          status: error.response?.status,
          message: error.message,
        });
        return Promise.reject(error);
      },
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
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        acquireTimeout: this.config.timeout,
        timeout: this.config.timeout,
        connectTimeout: this.config.timeout,
        timezone: "+00:00", // Doris stores UTC timestamps, tell mysql2 to interpret them as UTC
        // Doris returns String columns as BLOB via the MySQL protocol. Read them
        // explicitly as utf8 so 4-byte emoji survive decoding.
        //
        // JSON/Variant columns also need explicit utf8 handling before parsing.
        typeCast: function (field: any, next: () => any) {
          if (field.type === "BLOB") {
            return field.string("utf8");
          }

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
      // Doris (and any MySQL-protocol server) closes idle pooled connections
      // server-side. mysql2 can hand out such a stale socket, and the first
      // query on it rejects with PROTOCOL_CONNECTION_LOST / ECONNRESET before
      // a single byte is sent. The pool discards the dead connection on error,
      // so an immediate retry acquires a fresh one. Retry only these
      // connection-level transients (never mid-statement failures, which are
      // not safe to blindly replay) a couple of times with tiny backoff.
      const connectionLostCodes = new Set([
        "PROTOCOL_CONNECTION_LOST",
        "ECONNRESET",
        "EPIPE",
        "ETIMEDOUT",
      ]);
      const maxAttempts = 3;
      let rows: unknown;
      for (let attempt = 1; ; attempt++) {
        try {
          [rows] = await this.connectionPool.query(finalQuery);
          break;
        } catch (err) {
          const code = (err as { code?: string } | undefined)?.code;
          if (
            attempt >= maxAttempts ||
            !code ||
            !connectionLostCodes.has(code)
          ) {
            throw err;
          }
          logger.warn(
            `Doris query hit transient connection error ${code}; retrying (attempt ${attempt}/${maxAttempts - 1})`,
          );
          await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        }
      }
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
   * Execute a parameterized query with named parameters.
   * @param options Query options with query string and parameters
   * @returns Promise with json() method (kept for source-level compatibility
   *          with upstream call sites that expect this shape)
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

    // Wrap rows in an object that exposes json() so upstream call sites
    // (which expect the CH-style client shape) don't need rewriting.
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
   * Stream Load data into Doris table using HTTP API
   * @param table Target table name
   * @param data Array of records to insert
   * @param options Stream load options
   * @returns Promise<void>
   */
  async streamLoad<T = any>(
    table: string,
    data: T[],
    options: DorisStreamLoadOptions = {},
  ): Promise<void> {
    if (!data || data.length === 0) {
      logger.warn("No data provided for stream load", { table });
      return;
    }

    const loadOptions = {
      format: "json",
      strip_outer_array: true,
      read_json_by_line: true,
      timeout: 600, // 10 minutes
      ...options,
    };

    // Generate unique load label for idempotency. Doris rejects requests
    // that send both `label` and `group_commit` ("label and group_commit
    // can't be set at the same time"), so we skip the label header when
    // group_commit is on. Idempotency in that mode comes from the table's
    // UNIQUE KEY (events_full / scores / dataset_run_items all upsert by
    // stable keys, so a retried Stream Load is safe).
    const loadLabel = loadOptions.group_commit
      ? `group_commit:${table}`
      : `langfuse_${table}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Prepare request headers
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Expect: "100-continue",
      format: loadOptions.format,
      strip_outer_array: loadOptions.strip_outer_array.toString(),
      read_json_by_line: loadOptions.read_json_by_line.toString(),
      timeout: loadOptions.timeout.toString(),
      timezone: "UTC",
    };
    if (!loadOptions.group_commit) {
      headers.label = loadLabel;
    }

    // Partial column update (Doris Unique Key + Merge-on-Write).
    // The `columns` header lists key columns + the value columns this batch
    // intends to write; non-listed columns are preserved on the target row.
    if (loadOptions.partial_columns) {
      headers.partial_columns = "true";
    }
    if (loadOptions.columns) {
      headers.columns = loadOptions.columns;
    }
    if (loadOptions.partial_update_new_key_behavior) {
      headers.partial_update_new_key_behavior =
        loadOptions.partial_update_new_key_behavior;
    }
    if (loadOptions.group_commit) {
      headers.group_commit = loadOptions.group_commit;
    }
    if (
      loadOptions.group_commit &&
      typeof loadOptions.group_commit_interval_ms === "number"
    ) {
      headers.group_commit_interval_ms =
        loadOptions.group_commit_interval_ms.toString();
    }
    if (
      loadOptions.group_commit &&
      typeof loadOptions.group_commit_data_bytes === "number"
    ) {
      headers.group_commit_data_bytes =
        loadOptions.group_commit_data_bytes.toString();
    }

    // Convert data to JSON string
    const jsonData = JSON.stringify(data);

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

      // Stream Load transport. Two Doris topologies are supported:
      //
      // 1. Multi-node (FE separate from BE): Stream Load goes through an
      //    FE→307→BE redirect. FE doesn't ingest the body itself; it picks
      //    a BE per request (load-balancing + failover) and tells the
      //    client where to push. The naive "PUT the full body to FE and
      //    follow the redirect" is broken on Node.js: axios + Expect:
      //    100-continue still pre-fills one TCP send buffer (~64KB) before
      //    it sees the 307, and FE closes the connection right after
      //    sending the redirect — surfacing as `write EPIPE` whenever
      //    bodyBytes > 64KB. So we send an *empty-body* PUT to FE first
      //    (Content-Length: 0) to get the 307 + Location cheaply, then PUT
      //    the data straight to the redirected BE URL with a fresh
      //    `axios.put` (no agent reuse, per Doris's "fresh BE selection
      //    per load" guarantee).
      //
      // 2. Single-node (FE is the load entrypoint, e.g. embedded Doris):
      //    FE ingests the Stream Load inline and replies 200 with a Stream
      //    Load result body instead of a 307. There is no BE to redirect
      //    to and no redirect-close, so the EPIPE problem doesn't apply and
      //    we just PUT the full body to the FE in one shot. The empty-body
      //    probe commits a harmless 0-row txn, so once detected we cache
      //    `feIngestsInline` and skip the probe on subsequent loads.
      const feStartTs = Date.now();
      let response: any;

      // Inline-FE body PUT. Doris closes the connection after every Stream
      // Load (Connection: close), so the keep-alive socket left over from
      // the probe (or a prior load) is already half-closed and reusing it
      // yields `socket hang up`. Use a raw axios.put with a fresh socket —
      // same rationale as the BE leg below.
      const putBodyToFe = () =>
        axios.put(`${this.config.feHttpUrl}${url}`, jsonData, {
          headers: authHeaders,
          timeout: this.config.timeout,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        });

      if (this.feIngestsInline) {
        response = await putBodyToFe();
      } else {
        let probe: any;
        try {
          probe = await this.httpClient.put(url, "", {
            headers: { ...authHeaders, "Content-Length": "0" },
            maxRedirects: 0,
            // Accept both the expected 307 and 2xx/3xx so we can surface
            // FE-side rejections (e.g. missing Expect header, bad auth)
            // with a useful error instead of an axios HTTP error.
            validateStatus: (status: number) => status >= 200 && status < 400,
          });
        } catch (err: any) {
          logger.error(
            `[doris-diag] FE probe failed table=${table} loadLabel=${loadLabel} feUrl=${url} elapsedMs=${Date.now() - feStartTs} errCode=${err?.code} errSyscall=${err?.syscall} errno=${err?.errno} errCauseCode=${(err?.cause as any)?.code}: ${err?.message}`,
          );
          throw err;
        }

        if (probe.status === 307 && probe.headers?.location) {
          // Multi-node: follow the redirect and push the body to the BE.
          const redirectUrl = probe.headers.location.replace(
            /^http:\/\/[^@]+@/,
            "http://",
          );

          logger.debug("DorisClient: Sending body PUT to BE", {
            redirectUrl,
            bodyBytes: Buffer.byteLength(jsonData, "utf8"),
          });

          // [doris-diag] Track BE leg timing and bytes-sent-at-failure so
          // socket-level failures (EPIPE / ECONNRESET / ETIMEDOUT) can be
          // attributed to the BE side. Raw axios.put per Doris's
          // FE→BE redirect = per-load BE selection design (no agent reuse).
          const beStartTs = Date.now();
          let beBytesSent = 0;
          try {
            response = await axios.put(redirectUrl, jsonData, {
              headers: authHeaders,
              timeout: this.config.timeout,
              maxBodyLength: Infinity,
              maxContentLength: Infinity,
              onUploadProgress: (p: any) => {
                beBytesSent = p?.loaded ?? beBytesSent;
              },
            });
          } catch (err: any) {
            logger.error(
              `[doris-diag] BE leg failed table=${table} loadLabel=${loadLabel} redirectUrl=${redirectUrl} elapsedMs=${Date.now() - beStartTs} beBytesSent=${beBytesSent} bodyBytes=${Buffer.byteLength(jsonData, "utf8")} errCode=${err?.code} errSyscall=${err?.syscall} errno=${err?.errno} errCauseCode=${(err?.cause as any)?.code}: ${err?.message}`,
            );
            throw err;
          }
        } else if (
          probe.status >= 200 &&
          probe.status < 300 &&
          probe.data &&
          typeof probe.data === "object" &&
          ("TxnId" in probe.data || "Status" in probe.data)
        ) {
          // Single-node: FE ingested the empty probe inline (0 rows).
          // Cache that and re-send the real body to the FE in one PUT.
          this.feIngestsInline = true;
          response = await putBodyToFe();
        } else {
          // FE accepted the request but neither redirected nor returned a
          // Stream Load result — this is how it reports header / auth
          // errors (e.g. missing 100-continue, bad credentials, unknown
          // table). Surface the FE-side message verbatim.
          const data = probe.data;
          const detail =
            (typeof data === "object" && data !== null
              ? data.Message || data.msg || JSON.stringify(data)
              : String(data)) ||
            `FE returned status ${probe.status} without Location header`;
          throw new Error(`Stream load FE probe failed: ${detail}`);
        }
      }

      // Check load result
      const result = response.data;
      if (result.Status !== "Success") {
        // Extract error message from different response formats
        let errorMessage = "Unknown error";

        if (result.Message) {
          // Standard Stream Load error format
          errorMessage = result.Message;
        } else if (result.msg && result.data) {
          // Authentication or API error format
          errorMessage = `${result.msg}: ${result.data}`;
        } else if (result.msg) {
          // Simple message format
          errorMessage = result.msg;
        } else if (result.data) {
          // Data field contains error details
          errorMessage = result.data;
        } else if (typeof result === "string") {
          // Plain text response
          errorMessage = result;
        }

        logger.debug("DorisClient: Stream load failed", {
          responseData: result,
          errorMessage,
        });

        throw new Error(`Stream load failed: ${errorMessage}`);
      }

      if (env.LITEFUSE_DORIS_LOG_STREAM_LOAD_RESPONSE === "true") {
        logger.info(
          `Stream load completed ${JSON.stringify({ table, ...result })}`,
        );
      } else {
        logger.debug("Stream load completed", {
          table,
          recordCount: data.length,
          dataSizeKB: (Buffer.byteLength(jsonData, "utf8") / 1024).toFixed(2),
          loadLabel,
          response: result,
        });
      }
    } catch (error) {
      // Enhanced error handling for different error types
      let errorMessage = "Unknown error";

      if (error && typeof error === "object" && "response" in error) {
        // Axios HTTP error with response
        const axiosError = error as any;
        if (axiosError.response?.data) {
          const responseData = axiosError.response.data;

          logger.debug("DorisClient: HTTP error response data", {
            status: axiosError.response.status,
            statusText: axiosError.response.statusText,
            responseData: responseData,
          });

          if (responseData.msg && responseData.data) {
            errorMessage = `${responseData.msg}: ${responseData.data}`;
          } else if (responseData.msg) {
            errorMessage = responseData.msg;
          } else if (responseData.Message) {
            errorMessage = responseData.Message;
          } else if (typeof responseData === "string") {
            errorMessage = responseData;
          } else {
            errorMessage = `HTTP ${axiosError.response.status}: ${axiosError.response.statusText}`;
          }
        } else {
          errorMessage = axiosError.message || "Network error";
        }
      } else if (error instanceof Error) {
        errorMessage = error.message;
      } else {
        errorMessage = String(error);
      }

      // Inline errorMessage into the message string so it survives the
      // default text log format (which drops the metadata object). Without
      // this, "[E-217]json body size ... exceed BE's conf
      // streaming_load_json_max_mb ..." and similar BE-side rejections are
      // invisible until operators flip LITEFUSE_LOG_FORMAT=json.
      const dataSizeKB = (
        data.reduce(
          (acc, item) => acc + Buffer.byteLength(JSON.stringify(item), "utf8"),
          0,
        ) / 1024
      ).toFixed(2);
      logger.error(
        `Stream load failed for ${table} (loadLabel=${loadLabel}, recordCount=${data.length}, dataSizeKB=${dataSizeKB}): ${errorMessage}`,
      );

      throw new Error(errorMessage);
    }
  }

  /**
   * Batch insert with automatic retry mechanism
   * @param table Target table name
   * @param data Array of records to insert
   * @param options Stream load options
   * @returns Promise<void>
   */
  async insert<T = any>(
    table: string,
    data: T[],
    options: DorisStreamLoadOptions = {},
  ): Promise<void> {
    this._inflightInserts++;
    try {
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
        try {
          await this.streamLoad(table, data, options);
          return; // Success, exit retry loop
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));

          // Fail-fast on permanent client errors: retrying won't change
          // a 400-class rejection (malformed payload, schema mismatch,
          // bad header combo). Holds the SDK call hostage otherwise.
          if (isNonRetryableStreamLoadError(lastError)) {
            logger.warn(
              `Stream load failed for ${table} with non-retryable error, aborting retries: ${lastError.message}`,
            );
            break;
          }

          if (attempt < this.config.maxRetries) {
            // Exponential backoff, capped at 5s so worst-case total wait
            // stays bounded regardless of maxRetries.
            const delay = Math.min(
              this.config.retryDelay * Math.pow(2, attempt - 1),
              5000,
            );
            logger.warn(
              `Stream load attempt ${attempt} failed for ${table}, retrying in ${delay}ms: ${lastError.message}`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      // All retries failed
      // Safely calculate size by iterating instead of JSON.stringify (avoids ~374MB temp alloc for 2000×96KB)
      const dataSizeKB =
        data.reduce(
          (acc, item) => acc + Buffer.byteLength(JSON.stringify(item), "utf8"),
          0,
        ) / 1024;
      throw new Error(
        `Stream load failed after ${this.config.maxRetries} attempts: ${lastError?.message} | table=${table}, recordCount=${data.length}, dataSizeKB=${dataSizeKB.toFixed(2)}`,
      );
    } finally {
      this._inflightInserts--;
    }
  }

  /**
   * Wait for all in-flight `insert()` calls on this client to finish, up
   * to `timeoutMs`. Resolves either when the inflight counter reaches 0
   * or when the timeout elapses (whichever comes first). Always
   * resolves; the timeout is logged but not thrown so graceful shutdown
   * can proceed even if some loads are stuck. Returns the residual
   * inflight count for the caller's bookkeeping.
   */
  async waitForInflight(timeoutMs: number): Promise<number> {
    if (this._inflightInserts === 0) return 0;
    const deadline = Date.now() + timeoutMs;
    // 25ms poll keeps shutdown latency low; we expect most loads to
    // finish within a single Doris group-commit window (<1s).
    while (this._inflightInserts > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (this._inflightInserts > 0) {
      logger.warn(
        `DorisClient.waitForInflight: ${this._inflightInserts} insert(s) still in flight after ${timeoutMs}ms; proceeding with shutdown`,
      );
    }
    return this._inflightInserts;
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
    // Axios doesn't require explicit connection closing
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
   * Wait for all managed clients to drain their in-flight inserts.
   * Called by the graceful-shutdown path before `closeAllConnections()`
   * so we don't cut sockets out from under an in-flight Stream Load.
   * `timeoutMs` is per-client; the total wall-clock wait is bounded by
   * `timeoutMs` (clients are polled in parallel). Always resolves.
   */
  public async waitForAllInflight(timeoutMs: number): Promise<void> {
    await Promise.all(
      Array.from(this.clientMap.values()).map((client) =>
        client.waitForInflight(timeoutMs),
      ),
    );
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

const DATE_FIELD_MAPPINGS = {
  scores: { sourceField: "timestamp", dateField: "timestamp_date" },
  events_full: { sourceField: "start_time", dateField: "start_time_date" },
} as const;

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
      // as returned by Doris) are interpreted as UTC, not local time.
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
  metadata: Record<string, string> | undefined | null,
): Record<string, unknown> => {
  if (!metadata || typeof metadata !== "object") return {};

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (value == null || value === "") {
      result[key] = value ?? "";
      continue;
    }

    // Parse JSON strings (objects and arrays) to native values.
    // This removes the need for outer JSON.stringify to produce \"
    // escape sequences — the data becomes genuinely nested JSON.
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
 * events_full parallel-array value columns. Each element may be a
 * JSON-encoded string (e.g. OTel attributes like gen_ai.input.messages);
 * Doris's Stream Load JSON parser miscounts \" inside string elements and
 * silently absorbs subsequent array elements into the offender, producing
 * length mismatches with the paired *_names column. The workaround mirrors
 * the documented MAP column bug fix: parse JSON-shaped string elements back
 * to native objects so the outer JSON.stringify emits clean nested JSON
 * instead of \"-escaped text. Doris auto-stringifies the native object back
 * to a string when reading into the ARRAY<String> column.
 */
const EVENTS_FULL_VALUE_ARRAYS = [
  "metadata_values",
  "experiment_metadata_values",
  "experiment_item_metadata_values",
] as const;

const unstringJsonShapedArrayValues = (values: unknown): unknown => {
  if (!Array.isArray(values)) return values;
  return values.map((v) => {
    if (typeof v !== "string" || v.length === 0) return v;
    const c = v.charCodeAt(0);
    // 0x7B = '{', 0x5B = '['
    if (c !== 0x7b && c !== 0x5b) return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  });
};

/**
 * Elegant utility function to format data for Doris insertion
 * Handles data type conversion, null values, and date field generation
 */
export const formatDataForDoris = <T extends Record<string, any>>(
  data: T[],
  tableName?: string,
): T[] => {
  return data.map((record) => {
    // Step 1: Normalize all field values
    const formatted = Object.entries(record).reduce((acc, [key, value]) => {
      (acc as any)[key] = normalizeValue(key, value);
      return acc;
    }, {} as T);

    // Step 1.5: Normalize metadata to avoid Doris MAP parsing issues with
    // escaped quotes in JSON string values.
    if ("metadata" in formatted && formatted.metadata) {
      (formatted as any).metadata = normalizeMetadataForDoris(
        formatted.metadata,
      );
    }

    // Step 1.6: Normalize events_full parallel-array value columns for the
    // same reason — see EVENTS_FULL_VALUE_ARRAYS comment above.
    for (const arrayKey of EVENTS_FULL_VALUE_ARRAYS) {
      if (arrayKey in formatted) {
        (formatted as any)[arrayKey] = unstringJsonShapedArrayValues(
          (formatted as any)[arrayKey],
        );
      }
    }

    // Step 2: Generate date fields based on table type
    const mapping = tableName
      ? DATE_FIELD_MAPPINGS[tableName as keyof typeof DATE_FIELD_MAPPINGS]
      : null;

    if (mapping) {
      // Table-specific date field generation
      generateDateField(formatted, mapping.sourceField, mapping.dateField);
    } else {
      // Fallback: generate both possible date fields
      generateDateField(formatted, "timestamp", "timestamp_date");
      generateDateField(formatted, "start_time", "start_time_date");
    }

    return formatted;
  });
};
