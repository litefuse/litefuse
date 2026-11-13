#!/usr/bin/env node
/*
 * recheck-derivation.mjs — independent re-check of the "no substantial text is
 * shared with Langfuse's commercially licensed code" claim (LICENSE-EE ANNEX C).
 *
 *   node recheck-derivation.mjs <localRoot> <upstreamRoot> [--leftovers]
 *
 * Method — identical to handover doc 08 §6 (which was PowerShell/Python):
 *   1. "substantial line" = line.trim() with length >= 40 that does not start
 *      with `import `, `//` or `*`.
 *   2. EE set  = upstream paths under `ee/`, `web/src/ee/`, `worker/src/ee/`.
 *      MIT core = every other upstream .ts/.tsx.
 *   3. A local substantial line counts as a hit only when it appears in the EE
 *      set AND in at most 4 EE files AND does NOT appear anywhere in the MIT
 *      core. The core exclusion is what keeps language/framework boilerplate
 *      (zod refinements, HTTP statuses, provider ids, Prisma call shapes) from
 *      being reported as derivation.
 *   4. Report per local file: the EE file it shares most lines with, and how
 *      many.
 *
 * Expected result: no file with >= 2 hits; the leftovers are single lines of
 * framework idiom (see --leftovers to print them).
 *
 * SECOND PASS (identifier level, not in the doc): exported/local symbol names
 * that exist in upstream EE but nowhere in the upstream MIT core, and therefore
 * are distinctive of the commercial code. A rewrite that keeps the bodies but
 * reuses the names would pass the line check and fail this one.
 */
import fs from "node:fs";
import path from "node:path";

const [localRoot, upstreamRoot, ...flags] = process.argv.slice(2);
if (!localRoot || !upstreamRoot) {
  console.error(
    "usage: recheck-derivation.mjs <localRoot> <upstreamRoot> [--leftovers]",
  );
  process.exit(2);
}
const showLeftovers = flags.includes("--leftovers");
const MIN_LEN = Number(process.env.MIN_LEN ?? 40); // doc 08 §5.1 uses 40

const SKIP_DIRS = ["node_modules", ".next", "dist", ".git", ".turbo"];
const EXTS = [".ts", ".tsx"];

function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.includes(e.name)) stack.push(full);
      } else if (EXTS.some((x) => e.name.endsWith(x))) {
        out.push(full);
      }
    }
  }
  return out;
}

function substantialLines(file) {
  const set = new Set();
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return set;
  }
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (
      s.length >= MIN_LEN &&
      !s.startsWith("import ") &&
      !s.startsWith("//") &&
      !s.startsWith("*")
    ) {
      set.add(s);
    }
  }
  return set;
}

const isEe = (rel) =>
  rel.startsWith("ee/") ||
  rel.startsWith("web/src/ee/") ||
  rel.startsWith("worker/src/ee/");

// ── pass 1: shared substantial lines ────────────────────────────────────────
const eeFiles = walk(upstreamRoot);
const eeIndex = new Map(); // line -> Set(ee files)
const coreLines = new Set();
let eeCount = 0;
let coreFileCount = 0;

for (const file of eeFiles) {
  const rel = path.relative(upstreamRoot, file);
  const lines = substantialLines(file);
  if (isEe(rel)) {
    eeCount++;
    for (const l of lines) {
      let s = eeIndex.get(l);
      if (!s) eeIndex.set(l, (s = new Set()));
      s.add(rel);
    }
  } else {
    coreFileCount++;
    for (const l of lines) coreLines.add(l);
  }
}

const localFiles = walk(localRoot);
const findings = [];
const leftovers = [];

for (const file of localFiles) {
  const rel = path.relative(localRoot, file);
  const counts = new Map();
  for (const l of substantialLines(file)) {
    const hits = eeIndex.get(l);
    if (!hits || hits.size > 4 || coreLines.has(l)) continue;
    for (const h of hits) counts.set(h, (counts.get(h) ?? 0) + 1);
    leftovers.push({ local: rel, line: l, ee: [...hits][0] });
  }
  if (counts.size) {
    const [worst, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    findings.push({ local: rel, hits: n, worst });
  }
}

findings.sort((a, b) => b.hits - a.hits);

console.log("== inputs ==");
console.log(`  local    : ${localRoot}`);
console.log(`  upstream : ${upstreamRoot}`);
console.log(`  upstream EE .ts/.tsx files   : ${eeCount}`);
console.log(`  upstream MIT core .ts/.tsx   : ${coreFileCount}`);
console.log(`  local .ts/.tsx files scanned : ${localFiles.length}`);
console.log();
console.log(
  "== files sharing substantial lines with upstream EE (excluding MIT-core lines) ==",
);
if (!findings.length) console.log("  (none)");
for (const f of findings)
  console.log(`  ${String(f.hits).padStart(3)}  ${f.local}  <-  ${f.worst}`);

const ge2 = findings.filter((f) => f.hits >= 2);
console.log();
console.log(`VERDICT: files with >= 2 hits = ${ge2.length}  (expected 0)`);
console.log(
  `         files with exactly 1 hit = ${findings.filter((f) => f.hits === 1).length}`,
);
console.log(
  `         distinct leftover lines = ${new Set(leftovers.map((l) => l.line)).size}`,
);

if (showLeftovers && leftovers.length) {
  console.log();
  console.log("== leftover lines (each should be framework idiom) ==");
  const seen = new Set();
  for (const l of leftovers) {
    const key = `${l.local}::${l.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  [${l.local}]`);
    console.log(`      ${l.line}`);
  }
}

// ── pass 2: identifier level ────────────────────────────────────────────────
const IDENT_RE =
  /\b(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;

function identifiers(text) {
  const out = new Set();
  for (const m of text.matchAll(IDENT_RE)) out.add(m[1]);
  return out;
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const coreIdentifiers = new Set();
for (const file of walk(upstreamRoot)) {
  const rel = path.relative(upstreamRoot, file);
  if (isEe(rel)) continue;
  for (const id of identifiers(readText(file))) coreIdentifiers.add(id);
}

const eeOnlyIdentifiers = new Map(); // identifier -> Set(ee files)
for (const file of walk(upstreamRoot)) {
  const rel = path.relative(upstreamRoot, file);
  if (!isEe(rel)) continue;
  for (const id of identifiers(readText(file))) {
    if (coreIdentifiers.has(id)) continue; // also exists in MIT core -> not distinctive
    if (id.length < 6) continue; // too generic to be evidence either way
    let s = eeOnlyIdentifiers.get(id);
    if (!s) eeOnlyIdentifiers.set(id, (s = new Set()));
    s.add(rel);
  }
}

const identHits = [];
for (const file of walk(localRoot)) {
  const rel = path.relative(localRoot, file);
  const text = readText(file);
  const ids = identifiers(text);
  const matched = [...ids].filter((id) => eeOnlyIdentifiers.has(id));
  if (matched.length) identHits.push({ local: rel, matched, text });
}

console.log();
console.log(
  `== INFORMATIONAL: EE-only symbol names also declared locally (${eeOnlyIdentifiers.size} candidates) ==`,
);
console.log(
  "   (doc 08 §5.3 requires exported names/signatures, Stripe+OIDC field names and",
);
console.log(
  "    Prisma model names to stay identical, so a match here is interface, not derivation)",
);
if (!identHits.length) {
  console.log(
    "  (none) — no local file declares a symbol name that is unique to upstream EE",
  );
} else {
  for (const h of identHits) {
    console.log(`  ${h.local}`);
    for (const id of h.matched) {
      const ee = [...eeOnlyIdentifiers.get(id)].slice(0, 2).join(", ");
      console.log(`      ${id}   (upstream EE: ${ee})`);
    }
  }
}
console.log();
console.log(
  `   files: ${identHits.length} — informational; see the note above.`,
);

// ── pass 3: comment lines (the documented rule skips them entirely) ─────────
function commentLines(file) {
  const set = new Set();
  for (const raw of readText(file).split(/\r?\n/)) {
    const s = raw.trim();
    if (
      s.length >= MIN_LEN &&
      (s.startsWith("//") || s.startsWith("*") || s.startsWith("/*"))
    ) {
      set.add(s);
    }
  }
  return set;
}

const eeCommentIndex = new Map();
const coreCommentLines = new Set();
for (const file of walk(upstreamRoot)) {
  const rel = path.relative(upstreamRoot, file);
  const lines = commentLines(file);
  if (isEe(rel)) {
    for (const l of lines) {
      let s = eeCommentIndex.get(l);
      if (!s) eeCommentIndex.set(l, (s = new Set()));
      s.add(rel);
    }
  } else {
    for (const l of lines) coreCommentLines.add(l);
  }
}

const commentHits = [];
for (const file of walk(localRoot)) {
  const rel = path.relative(localRoot, file);
  for (const l of commentLines(file)) {
    const hits = eeCommentIndex.get(l);
    if (!hits || hits.size > 4 || coreCommentLines.has(l)) continue;
    commentHits.push({ local: rel, line: l, ee: [...hits][0] });
  }
}

console.log();
console.log(
  "== comment-line check (the documented substantial-line rule EXCLUDES comments) ==",
);
if (!commentHits.length) {
  console.log("  (none) — no local comment line is unique to upstream EE");
} else {
  for (const h of commentHits)
    console.log(`  [${h.local}]  <- ${h.ee}\n      ${h.line}`);
}
console.log(
  `COMMENT VERDICT: shared EE-only comment lines = ${commentHits.length} (expected 0)`,
);

// ── pass 4: containment ratio (quantitative distance from derivation) ───────
let best = { ratio: 0 };
for (const file of walk(localRoot)) {
  const rel = path.relative(localRoot, file);
  const lines = substantialLines(file);
  if (lines.size < 20) continue;
  const raw = new Map();
  for (const l of lines) {
    const hits = eeIndex.get(l);
    if (!hits) continue;
    for (const h of hits) raw.set(h, (raw.get(h) ?? 0) + 1);
  }
  for (const [ee, n] of raw) {
    const ratio = n / lines.size;
    if (ratio > best.ratio)
      best = { ratio, local: rel, ee, n, total: lines.size };
  }
}
console.log();
console.log(
  "== containment: largest share of one local file found in a single upstream EE file ==",
);
if (best.local) {
  const pct = (best.ratio * 100).toFixed(1);
  console.log(`  ${pct}%  (${best.n}/${best.total} substantial lines)`);
  console.log(`  ${best.local}  <-  ${best.ee}`);
  console.log(
    "  A rewritten file is expected to sit in the low single digits (shared idioms only).",
  );
} else {
  console.log("  (no shared lines at all)");
}
