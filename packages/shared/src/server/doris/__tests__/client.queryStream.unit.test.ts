import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { DorisClient } from "../client";

const { getConnection } = vi.hoisted(() => ({ getConnection: vi.fn() }));

vi.mock("mysql2/promise", () => ({
  default: { createPool: vi.fn(() => ({ on: vi.fn(), getConnection })) },
}));
vi.mock("../../env", () => ({ env: {} }));
vi.mock("../../instrumentation", () => ({ getCurrentSpan: vi.fn() }));
vi.mock("../../logger", () => ({
  logger: { debug: vi.fn(), error: vi.fn() },
}));

it("rejects on abort while the pool is busy and releases a late connection", async () => {
  const client = new DorisClient({ feHttpUrl: "http://localhost:8030" });
  const controller = new AbortController();
  const failure = new Error("Upload failed");
  const connection = {
    release: vi.fn(),
    destroy: vi.fn(),
    connection: { query: vi.fn() },
  };
  let deliverConnection!: (value: typeof connection) => void;
  getConnection.mockReturnValueOnce(
    new Promise<typeof connection>((resolve) => {
      deliverConnection = resolve;
    }),
  );

  const result = client
    .queryStream("SELECT 1", { signal: controller.signal })
    .next()
    .catch((error: unknown) => error);

  try {
    expect(getConnection).toHaveBeenCalledOnce();
    controller.abort(failure);
    await expect(
      Promise.race([result, setImmediate("Still waiting for a connection")]),
    ).resolves.toBe(failure);
  } finally {
    deliverConnection(connection);
    await result;
  }
  expect(connection.release).toHaveBeenCalledOnce();
  expect(connection.destroy).not.toHaveBeenCalled();
  expect(connection.connection.query).not.toHaveBeenCalled();
});
