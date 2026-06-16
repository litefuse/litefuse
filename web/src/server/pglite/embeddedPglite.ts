// Embedded PGlite for single-node litefuse.
//
// Runs an in-process PGlite instance (WASM Postgres) inside the litefuse web
// process and exposes it over the Postgres wire protocol via a multiplexing
// socket server. Prisma, pg-boss and the shared pg Pool then connect over
// loopback with an unchanged DATABASE_URL, so no external Postgres is needed.
//
// Started from instrumentation.ts before any DB access. The process is the
// single owner of the data directory — only one process may open a given
// PGlite dataDir at a time.
//
// Why a custom multiplexer (not @electric-sql/pglite-socket's server):
// PGlite is a *single* Postgres session, so the unnamed prepared statement
// ("") and unnamed portal are global. node-postgres clients (Prisma in
// `pgbouncer=true` mode and pg-boss) drive the extended query protocol with
// the unnamed statement, sending Parse/Bind/Describe/Execute/Sync as separate
// wire messages. The upstream multiplexer enqueues each message individually
// and only keeps per-connection affinity *while a transaction is open*, so it
// round-robins the Parse/Bind of ordinary parameterized queries — letting one
// connection's Parse("") clobber another's between its Parse and Bind. That
// surfaces as `bind message supplies N parameters, but prepared statement ""
// requires M` and breaks pg-boss queue creation under concurrent startup load.
//
// This server instead batches each connection's messages into a *group*
// (everything up to and including a Sync / simple Query terminator) and runs
// the whole group atomically under db.runExclusive, so the unnamed statement
// is never split across connections. It also preserves transaction affinity
// across groups: while the session is mid-transaction, only the connection
// that opened it may run, preventing cross-connection transaction corruption.
//
// PGlite also shares the namespace for *named* prepared statements and named
// portals across the single backend session. Prisma's schema engine uses names
// like "s0", so two logical client connections can collide even if each one is
// internally well-behaved. We therefore rewrite named statement / portal
// identifiers per connection before forwarding wire messages to PGlite.

import { createServer, type Server, type Socket } from "net";
import type { PGlite } from "@electric-sql/pglite";
import { rewriteFrontendMessageNames } from "./embeddedPgliteProtocol";

declare global {
  var embeddedPgliteStartPromise: Promise<void> | undefined;
}

// Postgres wire-protocol request codes for untyped startup-phase messages.
const PG_PROTOCOL_VERSION_3 = 196608; // 0x00030000
const SSL_REQUEST_CODE = 80877103;
const GSSENC_REQUEST_CODE = 80877104;
const CANCEL_REQUEST_CODE = 80877102;

// Frontend message-type bytes that close an extended-protocol request group.
// Sync ('S') and simple Query ('Q') both end with ReadyForQuery; Terminate
// ('X'), password/SASL ('p'), CopyDone ('c') and CopyFail ('f') are likewise
// safe boundaries to hand the session to another connection. Flush ('H') is
// deliberately *not* a terminator: it does not end the implicit group, and
// node-postgres / Prisma always close with Sync, so accumulating past a Flush
// keeps a connection's Parse/Bind/Execute together with its Sync.
const GROUP_TERMINATORS = new Set(["S", "Q", "X", "p", "c", "f"]);

type PendingMessage = Uint8Array;

interface ConnState {
  readonly id: number;
  readonly socket: Socket;
  buffer: Buffer;
  startupDone: boolean;
  pendingGroup: PendingMessage[];
  closed: boolean;
}

interface QueuedGroup {
  readonly conn: ConnState;
  readonly messages: PendingMessage[];
}

class PgliteWireServer {
  private readonly db: PGlite;
  private readonly host: string;
  private readonly port: number;
  private readonly maxConnections: number;
  private server: Server | null = null;

  private nextConnId = 1;
  private readonly conns = new Set<ConnState>();

  private readonly groupQueue: QueuedGroup[] = [];
  private processing = false;
  // While the shared PGlite session is mid-transaction, only this connection
  // may run, so another connection's statements never land inside the open
  // transaction (PGlite is a single session/backend).
  private txnOwner: number | null = null;

  // Watchdog for a connection that opens a transaction and then goes silent.
  // Because PGlite is one session, an idle open transaction blocks *all* other
  // DB work (head-of-line). If the owner sends nothing for txnIdleTimeoutMs we
  // force-reset that connection (closeConn rolls back) to free the session.
  private readonly txnIdleTimeoutMs: number;
  private txnIdleTimer: NodeJS.Timeout | null = null;

  constructor(params: {
    db: PGlite;
    host: string;
    port: number;
    maxConnections: number;
    txnIdleTimeoutMs: number;
  }) {
    this.db = params.db;
    this.host = params.host;
    this.port = params.port;
    this.maxConnections = params.maxConnections;
    this.txnIdleTimeoutMs = params.txnIdleTimeoutMs;
  }

  async start(): Promise<void> {
    await this.db.waitReady;
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.handleConnection(socket));
      server.on("error", reject);
      server.listen(this.port, this.host, () => {
        server.off("error", reject);
        this.server = server;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.clearTxnIdleTimer();
    for (const conn of this.conns) {
      try {
        conn.socket.destroy();
      } catch {
        // best-effort
      }
    }
    this.conns.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private handleConnection(socket: Socket): void {
    if (this.conns.size >= this.maxConnections) {
      try {
        // Minimal ErrorResponse-free rejection; clients retry/report ECONNRESET.
        socket.destroy();
      } catch {
        // best-effort
      }
      return;
    }

    socket.setNoDelay(true);
    const conn: ConnState = {
      id: this.nextConnId++,
      socket,
      buffer: Buffer.alloc(0),
      startupDone: false,
      pendingGroup: [],
      closed: false,
    };
    this.conns.add(conn);

    socket.on("data", (chunk: Buffer) => {
      try {
        this.onData(conn, chunk);
      } catch (err) {
        console.error(`[pglite] connection #${conn.id} parse error`, err);
        conn.socket.destroy();
      }
    });
    socket.on("error", () => this.closeConn(conn));
    socket.on("close", () => this.closeConn(conn));
  }

  private onData(conn: ConnState, chunk: Buffer): void {
    conn.buffer = conn.buffer.length
      ? Buffer.concat([conn.buffer, chunk])
      : chunk;

    let enqueuedAny = false;
    for (;;) {
      const message = this.takeMessage(conn);
      if (!message) break;
      if (message.kind === "ssl") {
        // Refuse SSL/GSS negotiation ('N'); loopback DATABASE_URL uses
        // sslmode=disable so this is only a safety net.
        if (conn.socket.writable) conn.socket.write(Buffer.from([0x4e]));
        continue;
      }
      if (message.kind === "cancel") {
        // CancelRequest targets a backend PID/secret; a single embedded
        // session has nothing to cancel. Drop and close per protocol.
        conn.socket.destroy();
        break;
      }
      conn.pendingGroup.push(
        message.rewriteNames
          ? rewriteFrontendMessageNames(conn.id, message.bytes)
          : message.bytes,
      );
      if (message.endsGroup) {
        this.groupQueue.push({ conn, messages: conn.pendingGroup });
        conn.pendingGroup = [];
        enqueuedAny = true;
      }
    }

    if (enqueuedAny) void this.processQueue();
  }

  // Pull one complete frontend message from the connection buffer, or null if
  // more bytes are needed. Classifies startup-phase (untyped) messages and
  // marks whether a typed message closes the current request group.
  private takeMessage(conn: ConnState):
    | { kind: "ssl" }
    | { kind: "cancel" }
    | {
        kind: "msg";
        bytes: Uint8Array;
        endsGroup: boolean;
        rewriteNames: boolean;
      }
    | null {
    const buf = conn.buffer;

    if (!conn.startupDone) {
      if (buf.length < 4) return null;
      const length = buf.readInt32BE(0);
      if (length < 8 || buf.length < length) {
        return buf.length < length ? null : { kind: "cancel" };
      }
      const code = buf.readInt32BE(4);
      if (code === SSL_REQUEST_CODE || code === GSSENC_REQUEST_CODE) {
        conn.buffer = buf.subarray(length);
        return { kind: "ssl" };
      }
      if (code === CANCEL_REQUEST_CODE) {
        conn.buffer = buf.subarray(length);
        return { kind: "cancel" };
      }
      // StartupMessage (protocol 3.0). Forward to PGlite, which replies with
      // the auth handshake (trust auth) and ReadyForQuery.
      if (code !== PG_PROTOCOL_VERSION_3) {
        throw new Error(`unsupported startup protocol code ${code}`);
      }
      const bytes = Uint8Array.prototype.slice.call(buf, 0, length);
      conn.buffer = buf.subarray(length);
      conn.startupDone = true;
      return { kind: "msg", bytes, endsGroup: true, rewriteNames: false };
    }

    // Typed messages: 1 type byte + Int32 length (length excludes type byte).
    if (buf.length < 5) return null;
    const length = buf.readInt32BE(1);
    const total = 1 + length;
    if (length < 4 || buf.length < total) return null;
    const type = String.fromCharCode(buf[0]);
    const bytes = Uint8Array.prototype.slice.call(buf, 0, total);
    conn.buffer = buf.subarray(total);
    return {
      kind: "msg",
      bytes,
      endsGroup: GROUP_TERMINATORS.has(type),
      rewriteNames: true,
    };
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    // Actively running again — cancel any pending idle-transaction watchdog.
    this.clearTxnIdleTimer();
    try {
      for (;;) {
        const group = this.dequeueGroup();
        if (!group) break;
        await this.runGroup(group);
      }
    } finally {
      this.processing = false;
    }
    // Everything runnable is drained. If a transaction is still open we're now
    // waiting on its owner to send more; arm the watchdog so a silent owner
    // cannot hold the single session indefinitely.
    this.armTxnIdleTimerIfNeeded();
  }

  private armTxnIdleTimerIfNeeded(): void {
    if (this.txnIdleTimer) return;
    if (this.txnIdleTimeoutMs <= 0) return;
    if (this.txnOwner === null || !this.db.isInTransaction()) return;
    const owner = this.txnOwner;
    this.txnIdleTimer = setTimeout(() => {
      this.txnIdleTimer = null;
      this.forceRollbackIdleTxn(owner);
    }, this.txnIdleTimeoutMs);
    // Don't let this watchdog keep the event loop alive on its own.
    if (typeof this.txnIdleTimer.unref === "function")
      this.txnIdleTimer.unref();
  }

  private clearTxnIdleTimer(): void {
    if (this.txnIdleTimer) {
      clearTimeout(this.txnIdleTimer);
      this.txnIdleTimer = null;
    }
  }

  // Fired when the owner of an open transaction has been idle too long. Tear
  // down that connection; closeConn rolls back the dangling transaction and
  // resumes the queue, so the single session becomes usable by others again.
  private forceRollbackIdleTxn(owner: number): void {
    if (this.processing) return; // a new group started; let it run
    if (this.txnOwner !== owner || !this.db.isInTransaction()) return;

    console.warn(
      `[pglite] connection #${owner} held an open transaction idle for ` +
        `${this.txnIdleTimeoutMs}ms; forcing reset to free the shared session`,
    );
    const conn = [...this.conns].find((c) => c.id === owner);
    if (conn) {
      // closeConn (socket 'close'/'error') performs the ROLLBACK + resume.
      conn.socket.destroy();
    } else {
      // Owner socket already gone but transaction still open: roll back here.
      this.txnOwner = null;
      void (async () => {
        try {
          if (this.db.isInTransaction()) await this.db.exec("ROLLBACK");
        } catch {
          // best-effort cleanup
        }
        void this.processQueue();
      })();
    }
  }

  // Choose the next group to run. While a transaction is open we must keep
  // feeding the owning connection; if it has nothing queued yet we stop and
  // wait — a later data event from that connection re-kicks processQueue.
  private dequeueGroup(): QueuedGroup | null {
    if (this.txnOwner !== null && this.db.isInTransaction()) {
      const idx = this.groupQueue.findIndex((g) => g.conn.id === this.txnOwner);
      if (idx === -1) return null;
      return this.groupQueue.splice(idx, 1)[0];
    }
    return this.groupQueue.shift() ?? null;
  }

  private async runGroup(group: QueuedGroup): Promise<void> {
    const { conn, messages } = group;
    try {
      await this.db.runExclusive(async () => {
        for (const message of messages) {
          await this.db.execProtocolRawStream(message, {
            onRawData: (data: Uint8Array) => {
              if (!conn.closed && conn.socket.writable) {
                conn.socket.write(Buffer.from(data));
              }
            },
          });
        }
      });
    } catch (err) {
      console.error(
        `[pglite] query group for connection #${conn.id} failed`,
        err,
      );
      // PGlite has already streamed any ErrorResponse it produced; tear down
      // this connection so the client resets cleanly rather than hanging.
      conn.socket.destroy();
    } finally {
      this.txnOwner = this.db.isInTransaction() ? conn.id : null;
    }
  }

  private closeConn(conn: ConnState): void {
    if (conn.closed) return;
    conn.closed = true;
    this.conns.delete(conn);
    conn.buffer = Buffer.alloc(0);
    conn.pendingGroup = [];

    // Drop any not-yet-run groups from this connection.
    for (let i = this.groupQueue.length - 1; i >= 0; i--) {
      if (this.groupQueue[i].conn.id === conn.id) this.groupQueue.splice(i, 1);
    }

    // If this connection held an open transaction on the shared session, roll
    // it back so the session is usable by others, then resume processing.
    // db.exec self-serializes via the PGlite mutex, so it queues behind any
    // in-flight group rather than nesting runExclusive.
    if (this.txnOwner === conn.id) {
      this.txnOwner = null;
      this.clearTxnIdleTimer();
      void (async () => {
        try {
          if (this.db.isInTransaction()) await this.db.exec("ROLLBACK");
        } catch {
          // best-effort cleanup
        }
        void this.processQueue();
      })();
    }
  }
}

const startEmbeddedPgliteOnce = async (): Promise<void> => {
  const { PGlite } = await import("@electric-sql/pglite");

  const dataDir = process.env.PGLITE_DATA_DIR ?? "./.pglite-data";
  const port = Number(process.env.PGLITE_PORT ?? 55432);
  const host = process.env.PGLITE_HOST ?? "127.0.0.1";
  const maxConnections = Number(process.env.PGLITE_MAX_CONNECTIONS ?? 100);
  // Watchdog for a connection that opens a transaction then goes silent and
  // would otherwise block the single shared session. 0 disables it.
  const txnIdleTimeoutMs = Number(
    process.env.PGLITE_TXN_IDLE_TIMEOUT_MS ?? 30000,
  );

  const db = await PGlite.create({ dataDir });
  await db.waitReady;

  // Force the session TimeZone to UTC. PGlite otherwise inherits the host
  // zone (e.g. Etc/GMT-8), which breaks the Postgres/Prisma convention that
  // naive `timestamp without time zone` columns hold UTC: raw-SQL casts like
  // `now()::timestamp` (used by the trace_sessions upsert) would store local
  // wall-clock time tagged as UTC — an 8h skew on e.g. created_at. Setting the
  // per-database default applies to every new wire session; the inline SET
  // covers the current backend session immediately.
  await db.exec(
    `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET TimeZone TO ''UTC''', current_database()); END $$;`,
  );
  await db.exec("SET TimeZone TO 'UTC';");

  const server = new PgliteWireServer({
    db,
    host,
    port,
    maxConnections,
    txnIdleTimeoutMs,
  });
  await server.start();

  console.log(
    `[pglite] embedded server listening on ${host}:${port} (dataDir=${dataDir}, maxConnections=${maxConnections})`,
  );

  const shutdown = async () => {
    try {
      await server.stop();
      await db.close();
    } catch {
      // best-effort on shutdown
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
};

export const startEmbeddedPglite = async (): Promise<void> => {
  globalThis.embeddedPgliteStartPromise ??= startEmbeddedPgliteOnce();
  return globalThis.embeddedPgliteStartPromise;
};
