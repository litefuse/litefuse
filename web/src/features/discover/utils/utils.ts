// @ts-nocheck
// --- stable stringify: recursively sort keys, avoid crash on circular references ---
function stableStringify(value: any): string {
  const seen = new WeakSet();

  const recur = (v: any): string => {
    if (v === null) {
      return "null";
    }
    const t = typeof v;
    if (t === "number") {
      return Number.isFinite(v) ? String(v) : "null";
    }
    if (t === "boolean") {
      return v ? "true" : "false";
    }
    if (t === "string") {
      return JSON.stringify(v);
    }
    if (t === "bigint") {
      return JSON.stringify(v.toString());
    }
    if (t === "undefined" || t === "function" || t === "symbol") {
      return "null";
    }

    // object / array
    if (seen.has(v)) {
      return '"[Circular]"';
    }
    seen.add(v);

    if (Array.isArray(v)) {
      return "[" + v.map(recur).join(",") + "]";
    }

    const keys = Object.keys(v).sort();
    const body = keys
      .map((k) => JSON.stringify(k) + ":" + recur(v[k]))
      .join(",");
    return "{" + body + "}";
  };

  return recur(value);
}

// --- helpers ---
function u8ToHex(u8: Uint8Array): string {
  let out = "";
  for (let i = 0; i < u8.length; i++) {
    out += u8[i].toString(16).padStart(2, "0");
  }
  return out;
}

function hasSubtle(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.crypto &&
    !!window.isSecureContext &&
    typeof window.crypto.subtle?.digest === "function"
  );
}

// --- pure JS SHA-256 fallback (simple implementation, no dependencies) ---
function sha256HexJS(data: Uint8Array): string {
  // constants
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  // initial hash values
  let h0 = 0x6a09e667,
    h1 = 0xbb67ae85,
    h2 = 0x3c6ef372,
    h3 = 0xa54ff53a,
    h4 = 0x510e527f,
    h5 = 0x9b05688c,
    h6 = 0x1f83d9ab,
    h7 = 0x5be0cd19;

  // pre-processing: padding
  const l = data.length;
  const bitLenHi = (l >>> 29) >>> 0;
  const bitLenLo = (l << 3) >>> 0;
  const nBlocks = (((l + 9) >> 6) + 1) << 4; // groups of 16 32-bit words
  const M = new Uint32Array(nBlocks);

  for (let i = 0; i < l; i++) {
    M[i >> 2] |= data[i] << ((3 - (i & 3)) << 3);
  }
  M[l >> 2] |= 0x80 << ((3 - (l & 3)) << 3);
  M[nBlocks - 2] = bitLenHi;
  M[nBlocks - 1] = bitLenLo;

  const W = new Uint32Array(64);

  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < nBlocks; i += 16) {
    for (let t = 0; t < 16; t++) {
      W[t] = M[i + t];
    }
    for (let t = 16; t < 64; t++) {
      const s0 =
        (rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3)) >>> 0;
      const s1 =
        (rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10)) >>> 0;
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }

    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;

    for (let t = 0; t < 64; t++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const T1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const T2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + T1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (T1 + T2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const H = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++) {
    out[i * 4 + 0] = (H[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (H[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (H[i] >>> 8) & 0xff;
    out[i * 4 + 3] = H[i] & 0xff;
  }
  return u8ToHex(out);
}

// --- generic SHA-256 (browser SubtleCrypto preferred, falls back to pure JS) ---
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  if (hasSubtle()) {
    const buf = await window.crypto.subtle.digest("SHA-256", data);
    return u8ToHex(new Uint8Array(buf));
  }
  // non-HTTPS or older environment: use pure JS
  return sha256HexJS(data);
}

// --- exported functions ---
export async function generateUid(obj: any) {
  const json = stableStringify(obj);
  return sha256Hex(json);
}

export async function generateTableDataUID(items: any[]) {
  // fall back to whole item when _original is absent; concurrent for speed
  const sources = items.map((it) => (it && it._original) ?? it);
  const uids = await Promise.all(sources.map(generateUid));
  return items.map((it, i) => ({ ...it, _uid: uids[i] }));
}

export function isIgnorableHighlightToken(token: string): boolean {
  const ignoreChars = new Set([
    ",",
    ".",
    ";",
    ":",
    "(",
    ")",
    "{",
    "}",
    "[",
    "]",
    "+",
    "-",
    "*",
    "/",
    "=",
    "<",
    ">",
    "!",
    "?",
    "|",
    "&",
    "%",
    "^",
    "$",
    "#",
    "@",
    "~",
    "`",
    "\\",
    "'",
    '"',
  ]);
  // all whitespace or newlines
  if (!token.trim()) {
    return true;
  }
  // single character that is in ignoreChars
  if (token.length === 1 && ignoreChars.has(token)) {
    return true;
  }
  // multiple characters but all punctuation
  if (
    /^[\u2000-\u206F\u2E00-\u2E7F!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]+$/.test(
      token,
    )
  ) {
    return true;
  }

  return false;
}
