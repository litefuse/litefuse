import { describe, it, expect } from "vitest";
import { zipDorisMetadataArrays } from "../dorisArrays";

describe("zipDorisMetadataArrays", () => {
  it("zips arrays already returned by the driver as native JS arrays", () => {
    const out = zipDorisMetadataArrays(["a", "b"], ["1", "2"]);
    expect(out).toEqual({ a: "1", b: "2" });
  });

  it("parses well-formed Doris JSON-text representation", () => {
    const names = '["a", "b"]';
    const values = '["1", "2"]';
    expect(zipDorisMetadataArrays(names, values)).toEqual({ a: "1", b: "2" });
  });

  // Doris's MySQL-protocol text representation of ARRAY<String> does NOT
  // escape inner " inside element strings. Receiver-side JSON.parse fails
  // on those rows; the fallback scanner recovers using the expected length
  // from the paired names array.
  it("recovers when values contain unescaped inner quotes", () => {
    const names = '["k1", "k2", "k3"]';
    // Doris emits literal { " k " : " v " } (no backslashes) inside the
    // element string, so the whole values column is not valid JSON.
    const values = '["plain", "{"query":"hello"}", "another"]';
    expect(zipDorisMetadataArrays(names, values)).toEqual({
      k1: "plain",
      k2: '{"query":"hello"}',
      k3: "another",
    });
  });

  it("preserves embedded comma+space inside the final element via expected length", () => {
    // Without the expected-length cap, the scanner would over-split this row.
    // With expectedLen=2 we treat everything after the first `", "` as element 2.
    const names = '["k1", "k2"]';
    const values = '["a", "say "hi, world" please"]';
    expect(zipDorisMetadataArrays(names, values)).toEqual({
      k1: "a",
      k2: 'say "hi, world" please',
    });
  });

  it("recovers a realistic OTel TOOL span (13 entries, two JSON-encoded values)", () => {
    const names = JSON.stringify([
      "gen_ai.operation.name",
      "gen_ai.session.id",
      "gen_ai.tool.call.arguments",
      "gen_ai.tool.call.id",
      "gen_ai.tool.call.result",
      "gen_ai.tool.name",
      "gen_ai.tool.type",
      "openclaw.channel.id",
      "openclaw.run.id",
      "openclaw.session.id",
      "openclaw.turn.id",
      "openclaw.version",
      "tool.duration_ms",
    ]).replace(/","/g, '", "'); // mimic Doris' `, ` separator
    // The two JSON-encoded values use literal inner quotes (no \) — the
    // exact format Doris emits over the MySQL protocol.
    const values =
      '["execute_tool", "uuid-1", "{"query":"hello"}", "call_id", "{"content":[{"type":"text"}]}", "web_search", "function", "system/telegram", "run-1", "uuid-1", "run-1", "2026.3.24", "1412"]';
    const out = zipDorisMetadataArrays(names, values);
    expect(Object.keys(out)).toHaveLength(13);
    expect(out["gen_ai.operation.name"]).toBe("execute_tool");
    expect(out["gen_ai.tool.call.arguments"]).toBe('{"query":"hello"}');
    expect(out["gen_ai.tool.call.result"]).toBe(
      '{"content":[{"type":"text"}]}',
    );
    expect(out["gen_ai.tool.name"]).toBe("web_search");
    expect(out["tool.duration_ms"]).toBe("1412");
  });

  it("returns empty object when names array is empty", () => {
    expect(zipDorisMetadataArrays("[]", "[]")).toEqual({});
  });

  it("ignores values when the input is not an array shape", () => {
    expect(zipDorisMetadataArrays("not an array", "also not")).toEqual({});
  });

  it("missing values per index degrade to empty string", () => {
    // names says 3 elements, values only has 2
    const names = '["a", "b", "c"]';
    const values = '["1", "2"]';
    const out = zipDorisMetadataArrays(names, values);
    expect(out).toEqual({ a: "1", b: "2", c: "" });
  });
});
