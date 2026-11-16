#!/usr/bin/env node
/*
 * provenance-report.mjs — evidence table for LICENSE-EE ANNEX C.
 *
 *   node provenance-report.mjs <repoRoot> <upstreamRoot> <commit>
 *
 * For every file the "de-derivation" commit touched, reports
 *   * the residual shared substantial lines with upstream's commercial (ee/) tree,
 *     using the documented method (>=40 chars, not import/comment, not present in
 *     upstream's MIT core, present in <=4 ee files), and
 *   * a heuristic classification of the change:
 *       string-only  — every changed line pair differs only inside string literals
 *       mixed        — some string-only pairs, some structural
 *       structural   — no string-only pairs
 *
 * The point is to be honest about which files were only re-worded: those are the
 * ones whose provenance cannot be settled by measuring line overlap.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [repoRoot, upstreamRoot, commit] = process.argv.slice(2);
if (!repoRoot || !upstreamRoot || !commit) {
  console.error(
    "usage: provenance-report.mjs <repoRoot> <upstreamRoot> <commit>",
  );
  process.exit(2);
}

const SKIP = ["node_modules", ".next", "dist", ".git", ".turbo"];
const walk = (root) => {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.includes(e.name)) stack.push(full);
      } else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
  }
  return out;
};

const substantial = (file) => {
  const set = new Set();
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const s = raw.trim();
    if (
      s.length >= 40 &&
      !s.startsWith("import ") &&
      !s.startsWith("//") &&
      !s.startsWith("*")
    )
      set.add(s);
  }
  return set;
};

const isEe = (rel) =>
  rel.startsWith("ee/") ||
  rel.startsWith("web/src/ee/") ||
  rel.startsWith("worker/src/ee/");

// upstream index
const eeIndex = new Map();
const coreLines = new Set();
for (const f of walk(upstreamRoot)) {
  const rel = path.relative(upstreamRoot, f).replace(/\\/g, "/");
  const lines = substantial(f);
  if (isEe(rel)) {
    for (const l of lines) {
      let s = eeIndex.get(l);
      if (!s) eeIndex.set(l, (s = new Set()));
      s.add(rel);
    }
  } else for (const l of lines) coreLines.add(l);
}

// files touched by the commit
const names = execFileSync(
  "git",
  ["-C", repoRoot, "show", "--pretty=", "--name-only", commit],
  {
    encoding: "utf8",
  },
)
  .split("\n")
  .map((s) => s.trim())
  .filter((s) => s.endsWith(".ts") || s.endsWith(".tsx"));

const STRINGISH = /^(.*?)(["'`])(?:[^"'`\\]|\\.)*\2(.*)$/;
const maskStrings = (line) => line.replace(/(["'`])(?:[^"'`\\]|\\.)*\1/g, '""');

function classify(file) {
  let diff;
  try {
    diff = execFileSync("git", ["-C", repoRoot, "show", commit, "--", file], {
      encoding: "utf8",
    });
  } catch {
    return { kind: "unknown", removed: 0, added: 0, stringOnly: 0 };
  }
  const removed = [];
  const added = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("-")) removed.push(line.slice(1));
    else if (line.startsWith("+")) added.push(line.slice(1));
  }
  // Pair by position within the hunk order: a cheap heuristic, good enough to
  // separate "re-worded" from "restructured".
  const n = Math.max(removed.length, added.length);
  let stringOnly = 0;
  for (let i = 0; i < n; i++) {
    const r = removed[i] ?? "";
    const a = added[i] ?? "";
    if (!r || !a) continue;
    if (maskStrings(r) === maskStrings(a) && STRINGISH.test(r)) stringOnly++;
  }
  const kind =
    stringOnly === 0
      ? "structural"
      : stringOnly >= n - 1
        ? "string-only"
        : "mixed";
  return { kind, removed: removed.length, added: added.length, stringOnly };
}

console.log("| file | residual shared lines | change | -/+ lines |");
console.log("| --- | --- | --- | --- |");
const rows = [];
for (const file of names) {
  const abs = path.join(repoRoot, file);
  let residual = 0;
  let worst = "";
  if (fs.existsSync(abs)) {
    const counts = new Map();
    for (const l of substantial(abs)) {
      const hits = eeIndex.get(l);
      if (!hits || hits.size > 4 || coreLines.has(l)) continue;
      for (const h of hits) counts.set(h, (counts.get(h) ?? 0) + 1);
    }
    for (const [k, v] of counts)
      if (v > residual) {
        residual = v;
        worst = k;
      }
  } else residual = -1; // deleted file
  const c = classify(file);
  rows.push({ file, residual, worst, ...c });
}
for (const r of rows) {
  console.log(
    `| \`${r.file}\` | ${r.residual < 0 ? "deleted" : r.residual} | ${r.kind}${r.stringOnly ? ` (${r.stringOnly} string-only)` : ""} | -${r.removed}/+${r.added} |`,
  );
}
console.log();
console.log(
  "string-only classification (needs provenance resolution, not a line count):",
);
for (const r of rows.filter((x) => x.kind === "string-only"))
  console.log(`  - ${r.file}`);
