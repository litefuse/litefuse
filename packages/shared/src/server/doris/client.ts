import axios, { AxiosInstance } from "axios";
import http from "http";
import https from "https";
import mysql from "mysql2/promise";
import { env } from "../../env";
import { getCurrentSpan } from "../instrumentation";
import { propagation, context } from "@opentelemetry/api";
import { logger } from "../logger";
import { DorisParameterProcessor } from "./parameterProcessor";

// Doris reports charset 33 (utf8) in MySQL protocol column metadata, but data is actually utf8mb4.
// mysql2 maps charset 33 to 'cesu8' (3-byte), causing 4-byte emoji characters to become U+FFFD.
// Override to 'utf8' which handles 4-byte sequences correctly in Node.js.
// mysql2 is in serverExternalPackages (next.config.mjs) so this internal require works at runtime.

// const CharsetToEncoding = require("mysql2/lib/constants/charset_encodings");
// CharsetToEncoding[33] = "utf8";

export interface DorisStreamLoadOptions {
  format?: "json" | "csv";
  columns?: string;
  jsonpaths?: string;
  strip_outer_array?: boolean;
  read_json_by_line?: boolean;
  max_filter_ratio?: number;
  timeout?: number;
  load_mem_limit?: number;
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
    jsonData: string,
    authHeaders: Record<string, string>,
  ) {
    const isAbsolute = /^https?:\/\//i.test(urlOrPath);
    return this.streamLoadClient.put(urlOrPath, jsonData, {
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

    // Generate unique load label for idempotency
    const loadLabel = `langfuse_${table}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

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

      // First attempt: try the FE endpoint
      logger.debug("DorisClient: Sending PUT request to FE", {
        url,
        headers: authHeaders,
      });

      // Manual 307 handling — Doris FE always redirects stream loads to a BE.
      let response = await this.streamLoadPut(url, jsonData, authHeaders);

      // Handle redirect manually if we get a 307 (this is normal behavior for Doris FE)
      if (response.status === 307 && response.headers?.location) {
        logger.debug("Handling manual redirect for Stream Load", {
          originalUrl: url,
          redirectUrl: response.headers.location,
        });

        // Strip embedded basic-auth credentials (Doris FE embeds user:pass@host
        // in the Location header). Supports both http:// and https://.
        const redirectUrl = response.headers.location.replace(
          /^(https?:\/\/)[^@/]+@/,
          "$1",
        );

        logger.debug("DorisClient: Sending PUT request to BE (redirect)", {
          redirectUrl,
        });

        // Make the request to the redirect URL with proper auth, reusing the
        // same keep-alive agents as the FE call so we don't open one TCP per
        // stream load.
        response = await this.streamLoadPut(redirectUrl, jsonData, authHeaders);
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

        logger.error("DorisClient: Stream load failed (verbose)", {
          responseData: result,
          errorMessage,
        });

        // Include ErrorURL in the thrown error so logs are usable for debugging
        // without needing to crank LOG_LEVEL to debug.
        const errorUrlSuffix =
          result && (result.ErrorURL || result.errorURL)
            ? ` (ErrorURL: ${result.ErrorURL ?? result.errorURL})`
            : "";
        throw new Error(`Stream load failed: ${errorMessage}${errorUrlSuffix}`);
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
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        await this.streamLoad(table, data, options);
        return; // Success, exit retry loop
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.maxRetries) {
          const delay = this.config.retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
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

const DATE_FIELD_MAPPINGS = {
  traces: { sourceField: "timestamp", dateField: "timestamp_date" },
  scores: { sourceField: "timestamp", dateField: "timestamp_date" },
  observations: { sourceField: "start_time", dateField: "start_time_date" },
  // events_full uses observation-shaped timestamps (start_time + start_time_date
  // partition key). Explicit mapping prevents formatDataForDoris from falling
  // back to the dual-column branch (which would also synthesize a stray
  // `timestamp_date` field that events_full doesn't have).
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
