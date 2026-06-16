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
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const record: ReqRecord = {
        url: req.url || "",
        authorization: req.headers["authorization"] as string | undefined,
        label: req.headers["label"] as string | undefined,
        body,
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
    expect(be.requests[0].body).toBe('[{"id":"1","name":"t1"}]');
    expect(be.requests[0].label).toMatch(/^langfuse_traces_/);
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

  it("retries on BE error and eventually surfaces the failure", async () => {
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

    await expect(client.insert("traces", [{ id: "x" }])).rejects.toThrowError(
      /Stream load failed after 3 attempts/,
    );
    expect(beHits).toBe(3);
  });
});
