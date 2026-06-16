import { rewriteFrontendMessageNames } from "@/src/server/pglite/embeddedPgliteProtocol";

const cstring = (value: string) => Buffer.from(`${value}\0`, "utf8");

const buildTypedMessage = (type: string, parts: Buffer[]): Uint8Array => {
  const bodyLength = parts.reduce((sum, part) => sum + part.length, 0);
  const message = Buffer.allocUnsafe(1 + 4 + bodyLength);
  message[0] = type.charCodeAt(0);
  message.writeInt32BE(4 + bodyLength, 1);

  let offset = 5;
  for (const part of parts) {
    part.copy(message, offset);
    offset += part.length;
  }

  return Uint8Array.prototype.slice.call(message);
};

const readCString = (
  buffer: Buffer,
  offset: number,
): { value: string; nextOffset: number } => {
  const end = buffer.indexOf(0, offset);
  if (end === -1) {
    throw new Error("unterminated cstring in test helper");
  }

  return {
    value: buffer.toString("utf8", offset, end),
    nextOffset: end + 1,
  };
};

describe("rewriteFrontendMessageNames", () => {
  it("namespaces Parse statement names per connection", () => {
    const parse = buildTypedMessage("P", [
      cstring("s0"),
      cstring("SELECT 1"),
      Buffer.from([0, 0]),
    ]);

    const rewritten = Buffer.from(rewriteFrontendMessageNames(7, parse));
    const { value: statementName, nextOffset } = readCString(rewritten, 5);
    const { value: query } = readCString(rewritten, nextOffset);

    expect(statementName).toBe("__lf_c7_stmt_s0");
    expect(query).toBe("SELECT 1");
  });

  it("namespaces Bind portal and statement names per connection", () => {
    const bind = buildTypedMessage("B", [
      cstring("p0"),
      cstring("s0"),
      Buffer.from([
        0,
        0, // format code count
        0,
        0, // param value count
        0,
        0, // result format count
      ]),
    ]);

    const rewritten = Buffer.from(rewriteFrontendMessageNames(3, bind));
    const { value: portalName, nextOffset } = readCString(rewritten, 5);
    const { value: statementName } = readCString(rewritten, nextOffset);

    expect(portalName).toBe("__lf_c3_portal_p0");
    expect(statementName).toBe("__lf_c3_stmt_s0");
  });

  it("rewrites Describe, Close and Execute names consistently", () => {
    const describe = buildTypedMessage("D", [
      Buffer.from("S", "utf8"),
      cstring("s0"),
    ]);
    const close = buildTypedMessage("C", [
      Buffer.from("P", "utf8"),
      cstring("p0"),
    ]);
    const execute = buildTypedMessage("E", [
      cstring("p0"),
      Buffer.from([0, 0, 0, 0]),
    ]);

    const rewrittenDescribe = Buffer.from(
      rewriteFrontendMessageNames(9, describe),
    );
    const rewrittenClose = Buffer.from(rewriteFrontendMessageNames(9, close));
    const rewrittenExecute = Buffer.from(
      rewriteFrontendMessageNames(9, execute),
    );

    expect(readCString(rewrittenDescribe, 6).value).toBe("__lf_c9_stmt_s0");
    expect(readCString(rewrittenClose, 6).value).toBe("__lf_c9_portal_p0");
    expect(readCString(rewrittenExecute, 5).value).toBe("__lf_c9_portal_p0");
  });

  it("leaves unnamed statements and portals untouched", () => {
    const parse = buildTypedMessage("P", [
      cstring(""),
      cstring("SELECT 1"),
      Buffer.from([0, 0]),
    ]);
    const bind = buildTypedMessage("B", [
      cstring(""),
      cstring(""),
      Buffer.from([
        0,
        0, // format code count
        0,
        0, // param value count
        0,
        0, // result format count
      ]),
    ]);

    const rewrittenParse = Buffer.from(rewriteFrontendMessageNames(5, parse));
    const rewrittenBind = Buffer.from(rewriteFrontendMessageNames(5, bind));

    expect(readCString(rewrittenParse, 5).value).toBe("");
    expect(readCString(rewrittenBind, 5).value).toBe("");
    expect(readCString(rewrittenBind, 6).value).toBe("");
  });
});
