import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http, { Server } from "http";
import type { AddressInfo } from "net";

// Mock heavy deps so DorisClient can be constructed without a real DB. axios
// is deliberately NOT mocked — we exercise the real HTTP path against in-process
// servers to verify the FE→BE redirect actually reuses our keep-alive agents.
vi.mock("mysql2/promise", () => ({
  default: { createPool: vi.fn(() => ({ on: vi.fn() })) },
  createPool: vi.fn(() => ({ on: vi.fn() })),
}));
vi.mock("../../instrumentation", () => ({ getCurrentSpan: vi.fn() }));
vi.mock("@opentelemetry/api", () => ({
  propagation: { inject: vi.fn() },
  context: { active: vi.fn() },
}));
vi.mock("../../logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("../../env", () => ({
  env: {
    DORIS_FE_HTTP_URL: "http://127.0.0.1:0",
    DORIS_FE_QUERY_PORT: 9030,
    DORIS_DB: "langfuse",
    DORIS_USER: "admin",
    DORIS_PASSWORD: "secret",
    DORIS_REQUEST_TIMEOUT_MS: 5000,
    DORIS_MAX_OPEN_CONNECTIONS: 10,
    LITEFUSE_INGESTION_DORIS_HTTP_MAX_SOCKETS: 8,
    LITEFUSE_ANALYTICS_BACKEND: "doris",
  },
}));

import { DorisClient } from "../client";

type ReqRecord = {
  url: string;
  authorization?: string;
  label?: string;
  contentLength?: string;
  transferEncoding?: string;
  stripOuterArray?: string;
  readJsonByLine?: string;
  body: string;
};

async function startServer(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    record: ReqRecord,
  ) => void,
): Promise<{
  server: Server;
  port: number;
  uniqueRemotePorts: Set<number>;
  totalConnections: () => number;
  requests: ReqRecord[];
}> {
  const uniqueRemotePorts = new Set<number>();
  let totalConnections = 0;
  const requests: ReqRecord[] = [];

  const server = http.createServer((req, res) => {
    // Accumulate raw buffers and decode once at the end — string-concatenating
    // data events would corrupt a multi-byte char split across TCP chunks.
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const record: ReqRecord = {
        url: req.url || "",
        authorization: req.headers["authorization"] as string | undefined,
        label: req.headers["label"] as string | undefined,
        contentLength: req.headers["content-length"] as string | undefined,
        transferEncoding: req.headers["transfer-encoding"] as
          | string
          | undefined,
        stripOuterArray: req.headers["strip_outer_array"] as string | undefined,
        readJsonByLine: req.headers["read_json_by_line"] as string | undefined,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(record);
      handler(req, res, record);
    });
  });
  server.on("connection", (socket) => {
    totalConnections += 1;
    if (socket.remotePort) uniqueRemotePorts.add(socket.remotePort);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    uniqueRemotePorts,
    totalConnections: () => totalConnections,
    requests,
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("DorisClient.streamLoad — FE→BE redirect connection reuse", () => {
  let fe: Awaited<ReturnType<typeof startServer>>;
  let be: Awaited<ReturnType<typeof startServer>>;
  let client: DorisClient;

  beforeEach(async () => {
    be = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          Status: "Success",
          NumberLoadedRows: 1,
          NumberTotalRows: 1,
        }),
      );
    });
    fe = await startServer((req, res, record) => {
      // Mirror Doris FE: 307 → BE with embedded creds in Location.
      const location = `http://admin:secret@127.0.0.1:${be.port}${record.url}`;
      res.writeHead(307, { Location: location });
      res.end();
    });

    client = new DorisClient({
      feHttpUrl: `http://127.0.0.1:${fe.port}`,
      database: "langfuse",
      username: "admin",
      password: "secret",
      timeout: 5000,
      maxRetries: 1,
      maxSockets: 8,
    });
  });

  afterEach(async () => {
    await closeServer(fe.server);
    await closeServer(be.server);
  });

  it("completes a single stream load via FE 307 → BE 200", async () => {
    await client.streamLoad("traces", [{ id: "1", name: "t1" }]);

    expect(fe.requests).toHaveLength(1);
    expect(be.requests).toHaveLength(1);
    // The EPIPE fix: the FE leg is an empty-body probe — no data bytes ever
    // flow to FE (which would 307-close the socket mid-body → write EPIPE).
    // Only the BE leg carries the actual payload.
    expect(fe.requests[0].body).toBe("");
    expect(be.requests[0].body).toBe('[{"id":"1","name":"t1"}]');
    expect(be.requests[0].label).toMatch(/^langfuse_traces_/);
  });

  it("streams a chunked StreamLoadBodySource with exact Content-Length, no chunked encoding, flags derived from format", async () => {
    // Multi-byte content on purpose: byteLength is UTF-8 bytes, not chars —
    // the exactness of Content-Length is what this test pins down (an
    // overcount stalls the request until timeout, an undercount aborts it).
    // Rows carry their trailing "\n", mirroring DorisWriter's NDJSON framing.
    const rows = [
      Buffer.from(
        JSON.stringify({ id: "1", name: "含中文", emoji: "🚀" }) + "\n",
      ),
      Buffer.from(JSON.stringify({ id: "2", name: "t2" }) + "\n"),
    ];
    const byteLength = rows.reduce((s, b) => s + b.length, 0);
    await client.insert(
      "traces",
      {
        format: "ndjson",
        byteLength,
        chunks: function* () {
          for (const row of rows) yield row;
        },
      },
      rows.length,
    );

    // FE probe stays body-less; only the BE leg carries the streamed payload.
    expect(fe.requests[0].body).toBe("");
    const expectedBody = rows.map((b) => b.toString("utf8")).join("");
    expect(be.requests[0].body).toBe(expectedBody);
    expect(be.requests[0].contentLength).toBe(
      String(Buffer.byteLength(expectedBody, "utf8")),
    );
    // A bare Readable would otherwise fall back to Transfer-Encoding: chunked;
    // the manual Content-Length must take effect instead.
    expect(be.requests[0].transferEncoding).toBeUndefined();
    // The body-shape flags must be derived from the source's format
    // discriminant, not from caller options/defaults.
    expect(be.requests[0].readJsonByLine).toBe("true");
    expect(be.requests[0].stripOuterArray).toBe("false");
  });

  it("legacy string-array path keeps the self-consistent default flag pairing", async () => {
    await client.streamLoad("traces", [{ id: "1" }, { id: "2" }]);
    // streamLoad serializes ONE JSON array → strip_outer_array pairs with it;
    // read_json_by_line must default to false (both-true is contradictory and
    // only tolerated because a JSON.stringify array is single-line).
    expect(be.requests[0].stripOuterArray).toBe("true");
    expect(be.requests[0].readJsonByLine).toBe("false");
    expect(be.requests[0].body).toBe('[{"id":"1"},{"id":"2"}]');
  });

  it("reuses TCP sockets across sequential stream loads (keep-alive)", async () => {
    const N = 5;
    for (let i = 0; i < N; i++) {
      await client.streamLoad("traces", [{ id: String(i) }]);
    }

    expect(fe.requests).toHaveLength(N);
    expect(be.requests).toHaveLength(N);

    // The whole point of the fix: with keep-alive + a real agent on the BE
    // redirect leg, sequential calls should reuse the same TCP connection.
    // Before the fix the BE leg used axios' default global agent (no keep-alive
    // bookkeeping on our side) and opened N fresh TCP connections, exhausting
    // the host's ephemeral ports in production.
    expect(be.totalConnections()).toBeLessThan(N);
    expect(fe.totalConnections()).toBeLessThan(N);
  });

  it("forwards the manually built Authorization header (instance auth would have clobbered it)", async () => {
    await client.streamLoad("traces", [{ id: "x" }]);

    // Authorization must reach BOTH FE and BE. If the BE leg silently dropped
    // it (e.g. via instance.auth overwrite), Doris would reject with 401.
    const expected = "Basic " + Buffer.from("admin:secret").toString("base64");
    expect(fe.requests[0].authorization).toBe(expected);
    expect(be.requests[0].authorization).toBe(expected);
  });

  it("strips embedded credentials from the redirect Location (http and https)", async () => {
    // Re-stub FE to return an https redirect with creds; we still verify the
    // outgoing URL doesn't carry user:pass@. Since we can't easily stand up TLS
    // here, intercept the request before BE is hit by routing back to http BE
    // and asserting on the rewritten URL via the BE request log.
    await closeServer(fe.server);
    fe = await startServer((req, res, record) => {
      res.writeHead(307, {
        Location: `http://oops:leaked@127.0.0.1:${be.port}${record.url}?probe=1`,
      });
      res.end();
    });
    client = new DorisClient({
      feHttpUrl: `http://127.0.0.1:${fe.port}`,
      database: "langfuse",
      username: "admin",
      password: "secret",
      timeout: 5000,
      maxRetries: 1,
      maxSockets: 8,
    });

    await client.streamLoad("traces", [{ id: "x" }]);

    // BE must have been hit, but the request URL it observed is the *path* only
    // — the credentials were stripped before the second PUT was issued. The
    // assertion that matters: BE received the call (regex-cleaned URL still
    // resolves correctly) and the Authorization header came from our manual
    // builder, not from the Location-embedded creds.
    expect(be.requests).toHaveLength(1);
    const expectedAuth =
      "Basic " + Buffer.from("admin:secret").toString("base64");
    expect(be.requests[0].authorization).toBe(expectedAuth);
    expect(be.requests[0].url).toContain("/api/langfuse/traces/_stream_load");
    expect(be.requests[0].url).toContain("probe=1");
  });

  it("forwards user-supplied default headers (DorisClientConfig.headers) to FE and BE", async () => {
    await closeServer(fe.server);
    await closeServer(be.server);

    // Regression guard: when streamLoadClient was first introduced it didn't
    // merge `this.config.headers`, so any caller-supplied default header
    // (X-Tenant, X-Request-Id, etc.) was silently dropped on the FE leg.
    const beHeaderSeen: string[] = [];
    const feHeaderSeen: string[] = [];
    be = await startServer((req, res) => {
      beHeaderSeen.push(String(req.headers["x-tenant"] || ""));
      res.writeHead(200);
      res.end(JSON.stringify({ Status: "Success" }));
    });
    fe = await startServer((req, res, record) => {
      feHeaderSeen.push(String(req.headers["x-tenant"] || ""));
      res.writeHead(307, {
        Location: `http://admin:secret@127.0.0.1:${be.port}${record.url}`,
      });
      res.end();
    });
    client = new DorisClient({
      feHttpUrl: `http://127.0.0.1:${fe.port}`,
      database: "langfuse",
      username: "admin",
      password: "secret",
      timeout: 5000,
      maxRetries: 1,
      maxSockets: 8,
      headers: { "X-Tenant": "acme" },
    });
    await client.streamLoad("traces", [{ id: "1" }]);
    expect(feHeaderSeen[0]).toBe("acme");
    expect(beHeaderSeen[0]).toBe("acme");
  });

  it("Location credential-strip regex covers http, https and @ in path", () => {
    // Mirror the regex literal in client.ts so a future edit that re-introduces
    // the old greedy /^http:\/\/[^@]+@/ trips a test immediately.
    const strip = (loc: string) => loc.replace(/^(https?:\/\/)[^@/]+@/, "$1");
    expect(strip("http://user:pass@host:8040/x")).toBe("http://host:8040/x");
    expect(strip("https://user:pass@host:8040/x")).toBe("https://host:8040/x");
    expect(strip("http://host:8040/x")).toBe("http://host:8040/x");
    // @ inside the path must NOT be treated as a credentials boundary.
    expect(strip("http://host:8040/path/has@symbol")).toBe(
      "http://host:8040/path/has@symbol",
    );
  });

  it("insert makes a single attempt and surfaces the failure (no internal retry)", async () => {
    await closeServer(be.server);
    let beHits = 0;
    be = await startServer((_req, res) => {
      beHits += 1;
      res.writeHead(502);
      res.end("bad gateway");
    });
    await closeServer(fe.server);
    fe = await startServer((req, res, record) => {
      res.writeHead(307, {
        Location: `http://admin:secret@127.0.0.1:${be.port}${record.url}`,
      });
      res.end();
    });

    client = new DorisClient({
      feHttpUrl: `http://127.0.0.1:${fe.port}`,
      database: "langfuse",
      username: "admin",
      password: "secret",
      timeout: 5000,
      maxRetries: 3,
      retryDelay: 1,
      maxSockets: 8,
    });

    // Retry is owned by the caller (DorisWriter), so insert() tries exactly
    // once and throws — the BE is hit a single time. The error must name the
    // failing LEG and its target URL (diagnosability: a bare axios message
    // like "timeout of 30000ms exceeded" doesn't say which hop broke).
    await expect(
      client.insert("traces", JSON.stringify([{ id: "x" }]), 1),
    ).rejects.toThrow(
      new RegExp(`\\[BE body PUT http://127\\.0\\.0\\.1:${be.port}`),
    );
    expect(beHits).toBe(1);
  });

  it("reports probed URL, status and verbatim response when the probe gets no 307", async () => {
    // The default `be` server answers 200 with a JSON body. The error must
    // report the facts AS-IS — probed URL, received status, raw response body
    // — with no interpretation baked in (the old message was just "FE probe
    // failed: OK", which named neither the URL nor the status).
    client = new DorisClient({
      feHttpUrl: `http://127.0.0.1:${be.port}`, // probe target answers 200
      database: "langfuse",
      username: "admin",
      password: "secret",
      timeout: 5000,
      maxRetries: 1,
      maxSockets: 8,
    });

    await expect(client.streamLoad("traces", [{ id: "x" }])).rejects.toThrow(
      new RegExp(
        `FE probe PUT http://127\\.0\\.0\\.1:${be.port}.*returned HTTP 200 without a 307 redirect; response: .*"Status":"Success"`,
      ),
    );
  });

  it("tags transport errors with the failing leg and target (connection refused on the FE probe)", async () => {
    // Point at a closed port: the probe can't even connect. The surfaced error
    // must say WHICH leg (FE probe) and WHERE (the exact URL), plus the
    // network error code — not just axios' bare message.
    const deadPort = fe.port;
    await closeServer(fe.server);

    client = new DorisClient({
      feHttpUrl: `http://127.0.0.1:${deadPort}`,
      database: "langfuse",
      username: "admin",
      password: "secret",
      timeout: 2000,
      maxRetries: 1,
      maxSockets: 8,
    });

    await expect(client.streamLoad("traces", [{ id: "x" }])).rejects.toThrow(
      new RegExp(
        `\\[FE probe PUT http://127\\.0\\.0\\.1:${deadPort}.*ECONNREFUSED`,
      ),
    );

    // afterEach closes fe.server — recreate a live one so it has something to close.
    fe = await startServer((_req, res) => {
      res.writeHead(307, { Location: `http://127.0.0.1:${be.port}/x` });
      res.end();
    });
  });

  // --- stable-label exactly-once semantics (verified against Doris 4.0.6) ---

  const labelAlreadyExists = (existingJobStatus?: string) =>
    JSON.stringify({
      TxnId: -1,
      Label: "ignored",
      Status: "Label Already Exists",
      ...(existingJobStatus ? { ExistingJobStatus: existingJobStatus } : {}),
      Message:
        "[LABEL_ALREADY_EXISTS]TStatus: errCode = 2, detailMessage = Label has already been used, relate to txn [42], status [VISIBLE].",
    });

  const swapBeResponse = async (body: string) => {
    await closeServer(be.server);
    be = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    });
    await closeServer(fe.server);
    fe = await startServer((req, res, record) => {
      res.writeHead(307, {
        Location: `http://admin:secret@127.0.0.1:${be.port}${record.url}`,
      });
      res.end();
    });
    client = new DorisClient({
      feHttpUrl: `http://127.0.0.1:${fe.port}`,
      database: "langfuse",
      username: "admin",
      password: "secret",
      timeout: 5000,
      maxRetries: 1,
      maxSockets: 8,
    });
  };

  it("caller-supplied stable label reaches the BE verbatim", async () => {
    await client.streamLoad("traces", [{ id: "1" }], {
      label: "langfuse_traces_123_stable-uuid",
    });
    expect(be.requests[0].label).toBe("langfuse_traces_123_stable-uuid");
    // FE probe carries it too (the FE registers the label at probe time).
    expect(fe.requests[0].label).toBe("langfuse_traces_123_stable-uuid");
  });

  it("stable label + Label Already Exists + FINISHED = SUCCESS (dedup, no re-park)", async () => {
    await swapBeResponse(labelAlreadyExists("FINISHED"));
    // Must RESOLVE: the earlier attempt of this batch committed; re-parking
    // would double-apply AGGREGATE-KEY SUM columns. The outcome reports the
    // dedup so exactly-once callers (otel group jobs) can branch on it.
    await expect(
      client.streamLoad("traces", [{ id: "1" }], { label: "stable-1" }),
    ).resolves.toEqual({ dedupedByLabel: true });
  });

  it("stable label + Label Already Exists + RUNNING = retryable failure", async () => {
    await swapBeResponse(labelAlreadyExists("RUNNING"));
    await expect(
      client.streamLoad("traces", [{ id: "1" }], { label: "stable-2" }),
    ).rejects.toThrow(/label busy.*RUNNING/s);
  });

  it("stable label + Label Already Exists without ExistingJobStatus falls back to SHOW TRANSACTION (unresolvable → retryable)", async () => {
    // The mocked mysql pool has no query(); resolveLabelTxnStatus catches and
    // returns UNKNOWN → the client must throw a retryable error rather than
    // either wedging or falsely succeeding.
    await swapBeResponse(labelAlreadyExists(undefined));
    await expect(
      client.streamLoad("traces", [{ id: "1" }], { label: "stable-3" }),
    ).rejects.toThrow(/txn status UNKNOWN/);
  });

  it("WITHOUT a caller label, Label Already Exists stays a plain failure (collision, not dedup)", async () => {
    await swapBeResponse(labelAlreadyExists("FINISHED"));
    // Generated per-attempt labels must never treat "already exists" as
    // success — that response can only mean a collision with someone else's
    // load, and swallowing it would silently drop this batch.
    await expect(client.streamLoad("traces", [{ id: "1" }])).rejects.toThrow(
      /Label Already Exists/,
    );
  });
});
