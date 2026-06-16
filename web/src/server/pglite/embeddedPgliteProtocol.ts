const cstring = (value: string): Buffer => Buffer.from(`${value}\0`, "utf8");

const readCString = (
  buffer: Buffer,
  offset: number,
): { value: string; nextOffset: number } => {
  const end = buffer.indexOf(0, offset);
  if (end === -1) {
    throw new Error("Invalid Postgres wire message: unterminated cstring");
  }

  return {
    value: buffer.toString("utf8", offset, end),
    nextOffset: end + 1,
  };
};

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

const rewriteStatementName = (connId: number, statementName: string): string =>
  statementName === ""
    ? statementName
    : `__lf_c${connId}_stmt_${statementName}`;

const rewritePortalName = (connId: number, portalName: string): string =>
  portalName === "" ? portalName : `__lf_c${connId}_portal_${portalName}`;

const rewriteParseMessage = (connId: number, message: Buffer): Uint8Array => {
  const { value: statementName, nextOffset: queryOffset } = readCString(
    message,
    5,
  );
  const { value: query, nextOffset: restOffset } = readCString(
    message,
    queryOffset,
  );

  return buildTypedMessage("P", [
    cstring(rewriteStatementName(connId, statementName)),
    cstring(query),
    message.subarray(restOffset),
  ]);
};

const rewriteBindMessage = (connId: number, message: Buffer): Uint8Array => {
  const { value: portalName, nextOffset: statementOffset } = readCString(
    message,
    5,
  );
  const { value: statementName, nextOffset: restOffset } = readCString(
    message,
    statementOffset,
  );

  return buildTypedMessage("B", [
    cstring(rewritePortalName(connId, portalName)),
    cstring(rewriteStatementName(connId, statementName)),
    message.subarray(restOffset),
  ]);
};

const rewriteDescribeOrCloseMessage = (
  connId: number,
  type: "D" | "C",
  message: Buffer,
): Uint8Array => {
  const targetType = String.fromCharCode(message[5] ?? 0);
  const { value: name } = readCString(message, 6);

  const rewrittenName =
    targetType === "S"
      ? rewriteStatementName(connId, name)
      : targetType === "P"
        ? rewritePortalName(connId, name)
        : name;

  return buildTypedMessage(type, [
    Buffer.from(targetType, "utf8"),
    cstring(rewrittenName),
  ]);
};

const rewriteExecuteMessage = (connId: number, message: Buffer): Uint8Array => {
  const { value: portalName, nextOffset: restOffset } = readCString(message, 5);

  return buildTypedMessage("E", [
    cstring(rewritePortalName(connId, portalName)),
    message.subarray(restOffset),
  ]);
};

export const rewriteFrontendMessageNames = (
  connId: number,
  rawMessage: Uint8Array,
): Uint8Array => {
  const message = Buffer.from(rawMessage);
  const type = String.fromCharCode(message[0] ?? 0);

  switch (type) {
    case "P":
      return rewriteParseMessage(connId, message);
    case "B":
      return rewriteBindMessage(connId, message);
    case "D":
    case "C":
      return rewriteDescribeOrCloseMessage(connId, type, message);
    case "E":
      return rewriteExecuteMessage(connId, message);
    default:
      return rawMessage;
  }
};
