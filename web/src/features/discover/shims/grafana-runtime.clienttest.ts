// @ts-nocheck
import { lastValueFrom } from "rxjs";
import {
  getBackendSrv,
  getDiscoverProjectId,
  setDiscoverProjectId,
} from "./grafana-runtime";

describe("grafana-runtime project ID resolution", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    setDiscoverProjectId("");
    window.history.replaceState({}, "", "/");
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("falls back to the discover URL when project ID has not been injected yet", async () => {
    window.history.replaceState(
      {},
      "",
      "/project/test-project/logging?from=now-15m",
    );

    expect(getDiscoverProjectId()).toBe("test-project");

    await lastValueFrom(
      getBackendSrv().fetch({
        url: "/api/ds/query",
        method: "POST",
        data: {
          queries: [
            {
              refId: "test",
              rawSql: "SELECT 1",
              format: "table",
            },
          ],
        },
      }),
    );

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/project/test-project/discover-query",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });
});
