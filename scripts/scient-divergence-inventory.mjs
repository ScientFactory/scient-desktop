#!/usr/bin/env node
// Advisory source inventory: never changes Git objects, refs, checkouts or CI.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import ts from "typescript-legacy";

const sha = (value) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const git = (cwd, args) =>
  NodeChildProcess.execFileSync(
    "git",
    ["--no-lazy-fetch", "--no-replace-objects", "--literal-pathspecs", ...args],
    {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    },
  );
const utf8 = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const fullId = /^[a-f0-9]{40}$/;
const date = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function tree(cwd, ref, commit = false) {
  if (!fullId.test(ref ?? "")) throw new Error("Use an exact full 40-character object ID");
  return utf8(
    git(cwd, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{${commit ? "commit" : "tree"}}`,
    ]),
  ).trim();
}
function entries(cwd, ref) {
  const result = new Map();
  for (const record of utf8(git(cwd, ["ls-tree", "-r", "-z", ref])).split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, type, blob] = record.slice(0, tab).split(" ");
    if (tab < 0 || !fullId.test(blob)) throw new Error("Invalid tree entry");
    result.set(record.slice(tab + 1), { mode, type, blob });
  }
  return result;
}

/** Only AST-associated comments count. Literal/token spans exclude apparent comments in data. */
export function commentIntervals(path, text) {
  const kinds = {
    ".ts": ts.ScriptKind.TS,
    ".tsx": ts.ScriptKind.TSX,
    ".js": ts.ScriptKind.JS,
    ".jsx": ts.ScriptKind.JSX,
    ".mjs": ts.ScriptKind.JS,
    ".cjs": ts.ScriptKind.JS,
    ".mts": ts.ScriptKind.TS,
    ".cts": ts.ScriptKind.TS,
  };
  const kind = kinds[NodePath.extname(path)];
  if (kind === undefined) return { status: "unsupported-language", intervals: [] };
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  if (source.parseDiagnostics.length)
    return {
      status: "parser-error",
      intervals: [],
      details: source.parseDiagnostics.map((d) =>
        ts.flattenDiagnosticMessageText(d.messageText, " "),
      ),
    };
  const ranges = new Map();
  const protectedSpans = [];
  const take = (items) => {
    for (const item of items ?? []) ranges.set(`${item.pos}:${item.end}`, item);
  };
  const visit = (node) => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateLiteralToken(node) ||
      node.kind === ts.SyntaxKind.RegularExpressionLiteral ||
      node.kind === ts.SyntaxKind.JsxText
    )
      protectedSpans.push([node.getStart(source), node.end]);
    take(ts.getLeadingCommentRanges(text, node.pos));
    take(ts.getTrailingCommentRanges(text, node.end));
    if (ts.isJsxExpression(node)) {
      take(ts.getLeadingCommentRanges(text, node.getStart(source) + 1));
      take(ts.getTrailingCommentRanges(text, node.getStart(source) + 1));
    }
    // Include punctuation tokens: END comments before a closing brace belong
    // to that token, which forEachChild deliberately omits.
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  take(ts.getLeadingCommentRanges(text, 0));
  const markers = [];
  let generated = false;
  for (const range of [...ranges.values()].sort((a, b) => a.pos - b.pos)) {
    if (protectedSpans.some(([start, end]) => range.pos < end && range.end > start)) continue;
    const bodyStart = range.pos + 2;
    const body = text.slice(
      bodyStart,
      range.kind === ts.SyntaxKind.MultiLineCommentTrivia ? range.end - 2 : range.end,
    );
    if (range.pos < 2048 && /@generated\b|generated[^\n]*do not edit/i.test(body)) generated = true;
    for (const match of body.matchAll(/^[ \t]*(?:\*[ \t]*)?SCIENT-FORK:(START|END)\b[^\r\n]*/gm)) {
      const offset = bodyStart + match.index;
      markers.push({ type: match[1], line: source.getLineAndCharacterOfPosition(offset).line + 1 });
    }
  }
  const stack = [],
    intervals = [],
    errors = [];
  for (const marker of markers) {
    if (marker.type === "START") stack.push(marker.line);
    else if (!stack.length) errors.push(`Orphan END at line ${marker.line}`);
    else intervals.push({ start: stack.pop(), end: marker.line });
  }
  for (const start of stack) errors.push(`Unclosed START at line ${start}`);
  intervals.sort((a, b) => a.start - b.start || b.end - a.end);
  // A malformed file cannot certify any hunk, even if some pairs happened to match.
  return {
    status: errors.length ? "malformed-markers" : "parsed",
    intervals: errors.length ? [] : intervals,
    errors,
    generated,
  };
}

function hunks(patch) {
  const result = [];
  let current;
  for (const line of patch.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      current = {
        oldStart: +match[1],
        oldCount: +(match[2] ?? 1),
        newStart: +match[3],
        newCount: +(match[4] ?? 1),
        removed: [],
        added: [],
      };
      result.push(current);
    } else if (current && line.startsWith("+")) current.added.push(line.slice(1));
    else if (current && line.startsWith("-")) current.removed.push(line.slice(1));
  }
  for (const hunk of result)
    if (hunk.removed.length !== hunk.oldCount || hunk.added.length !== hunk.newCount)
      throw new Error("Hunk count mismatch");
  return result;
}
function validateBaseline(baseline, upstream, asOf, candidateEntries, cwd) {
  if (!baseline) return new Map();
  if (!date(asOf ?? ""))
    throw new Error("A baseline requires an explicit valid --as-of YYYY-MM-DD");
  if (
    baseline.schemaVersion !== 1 ||
    baseline.upstream !== upstream ||
    !Array.isArray(baseline.entries)
  )
    throw new Error("Baseline schema/upstream mismatch");
  const result = new Map();
  for (const entry of baseline.entries) {
    if (!/^[a-f0-9]{64}$/.test(entry.fingerprint ?? "") || result.has(entry.fingerprint))
      throw new Error("Invalid or duplicate baseline fingerprint");
    if (
      typeof entry.owner !== "string" ||
      !entry.owner.trim() ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim()
    )
      throw new Error("Baseline requires owner and reason");
    if (!date(entry.expiresAt ?? "") || entry.expiresAt < asOf)
      throw new Error("Invalid or expired baseline entry");
    const record = entry.reviewRecord;
    const stored = candidateEntries.get(record);
    if (
      typeof record !== "string" ||
      !record.startsWith("docs/") ||
      NodePath.posix.normalize(record) !== record ||
      record.includes("\\") ||
      !stored ||
      stored.type !== "blob" ||
      !["100644", "100755"].includes(stored.mode) ||
      !git(cwd, ["cat-file", "blob", stored.blob]).length
    )
      throw new Error("Baseline needs a nonempty committed regular docs/ review record");
    result.set(entry.fingerprint, entry);
  }
  return result;
}

/** Inventory all changed upstream paths; candidate-only files are listed without an origin claim. */
export function inspectScientDivergence({
  cwd = process.cwd(),
  upstream,
  candidate,
  baseline,
  asOf,
} = {}) {
  const report = {
    schemaVersion: 1,
    upstream,
    candidate,
    status: "advisory",
    scope: "TS/TSX/JS/JSX genuine comments; other languages remain unresolved",
    files: [],
    candidateOnly: [],
    errors: [],
  };
  try {
    tree(cwd, upstream, true);
    const upstreamTree = tree(cwd, upstream),
      candidateTree = tree(cwd, candidate);
    report.upstreamTree = upstreamTree;
    report.candidateTree = candidateTree;
    const original = entries(cwd, upstreamTree),
      current = entries(cwd, candidateTree);
    const reviewed = validateBaseline(baseline, upstream, asOf, current, cwd);
    const matched = new Set();
    for (const path of [...current.keys()].filter((path) => !original.has(path)).sort(order))
      report.candidateOnly.push(path);
    for (const path of [...original.keys()].sort(order)) {
      const before = original.get(path),
        after = current.get(path);
      if (after && before.blob === after.blob && before.mode === after.mode) continue;
      const file = {
        path,
        upstreamBlob: before.blob,
        candidateBlob: after?.blob ?? null,
        findings: [],
        intervals: [],
      };
      const finding = (kind, content = {}, unresolved = false) => {
        const fingerprint = sha(
          JSON.stringify({ path, upstreamBlob: before.blob, kind, ...content }),
        );
        const review = !unresolved && reviewed.get(fingerprint);
        if (review) matched.add(fingerprint);
        file.findings.push({
          kind,
          ...content,
          fingerprint,
          disposition: unresolved ? "unresolved" : review ? "reviewed-historical-debt" : "new-debt",
          ...(review ? { review } : {}),
        });
      };
      report.files.push(file);
      if (!after) {
        finding("file-deletion", { upstreamMode: before.mode });
        continue;
      }
      if (before.mode !== after.mode)
        finding("mode-change", { upstreamMode: before.mode, candidateMode: after.mode });
      if (before.blob === after.blob) continue;
      if (
        before.type !== "blob" ||
        after.type !== "blob" ||
        !["100644", "100755"].includes(before.mode) ||
        !["100644", "100755"].includes(after.mode)
      ) {
        finding("non-regular-content", {
          candidateBlob: after.blob,
          upstreamMode: before.mode,
          candidateMode: after.mode,
        });
        continue;
      }
      const oldBytes = git(cwd, ["cat-file", "blob", before.blob]),
        newBytes = git(cwd, ["cat-file", "blob", after.blob]);
      if (oldBytes.includes(0) || newBytes.includes(0)) {
        finding("binary-content", { candidateBlob: after.blob });
        continue;
      }
      let text;
      try {
        text = utf8(newBytes);
        utf8(oldBytes);
      } catch {
        finding("unsupported-encoding", { candidateBlob: after.blob }, true);
        continue;
      }
      if (NodePath.extname(path) === ".json" || path === "pnpm-lock.yaml") {
        finding("unmarkable-artifact", { candidateBlob: after.blob });
        continue;
      }
      const parsed = commentIntervals(path, text);
      file.intervals = parsed.intervals;
      if (parsed.status !== "parsed") {
        finding(
          parsed.status,
          { candidateBlob: after.blob, details: parsed.details ?? parsed.errors ?? [] },
          true,
        );
        continue;
      }
      if (parsed.generated) {
        finding("generated-content", { candidateBlob: after.blob });
        continue;
      }
      const patch = utf8(
        git(cwd, [
          "-c",
          "diff.algorithm=myers",
          "-c",
          "diff.indentHeuristic=false",
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--no-renames",
          "--unified=0",
          upstreamTree,
          candidateTree,
          "--",
          path,
        ]),
      );
      const changes = hunks(patch);
      if (!changes.length) {
        finding("unresolved-diff", { candidateBlob: after.blob }, true);
        continue;
      }
      const lines = text.split("\n");
      for (const hunk of changes) {
        const marked = hunk.newCount
          ? Array.from({ length: hunk.newCount }, (_, i) => hunk.newStart + i).every((line) =>
              parsed.intervals.some(({ start, end }) => start <= line && line <= end),
            )
          : parsed.intervals.some(
              ({ start, end }) => start <= hunk.newStart && hunk.newStart < end,
            );
        const content = {
          ...hunk,
          context: lines.slice(
            Math.max(0, hunk.newStart - 4),
            hunk.newStart + Math.max(0, hunk.newCount) + 2,
          ),
        };
        if (marked)
          file.findings.push({
            kind: hunk.newCount ? "addition-or-replacement" : "deletion-gap",
            ...content,
            disposition: "marked",
          });
        else finding(hunk.newCount ? "addition-or-replacement" : "deletion-gap", content);
      }
    }
    report.unmatchedBaseline = [...reviewed.keys()].filter((id) => !matched.has(id)).sort(order);
    report.counts = { marked: 0, "new-debt": 0, "reviewed-historical-debt": 0, unresolved: 0 };
    for (const file of report.files)
      for (const item of file.findings) report.counts[item.disposition]++;
    report.ratchet =
      report.counts["new-debt"] || report.counts.unresolved
        ? "needs-review"
        : "no-new-debt-within-declared-scope";
  } catch (error) {
    report.status = "unavailable";
    report.ratchet = "unavailable";
    report.errors.push(String(error.message));
  }
  return report;
}

let invokedAsMain = false;
try {
  if (process.argv[1])
    invokedAsMain =
      NodeFS.realpathSync(NodeURL.fileURLToPath(import.meta.url)) ===
      NodeFS.realpathSync(process.argv[1]);
} catch (error) {
  process.stderr.write(`Unable to resolve CLI entry identity: ${error.message}\n`);
  process.exitCode = 2;
}

if (invokedAsMain) {
  try {
    const options = {},
      args = process.argv.slice(2);
    let ratchet = false;
    while (args.length) {
      const arg = args.shift();
      if (arg === "--ratchet") ratchet = true;
      else if (["--upstream", "--candidate", "--baseline", "--as-of"].includes(arg) && args.length)
        options[arg.slice(2).replace("as-of", "asOf")] = args.shift();
      else throw new Error(`Unknown or incomplete option: ${arg}`);
    }
    if (options.baseline)
      options.baseline = JSON.parse(NodeFS.readFileSync(options.baseline, "utf8"));
    const report = inspectScientDivergence(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode =
      report.status === "unavailable" ? 2 : ratchet && report.ratchet === "needs-review" ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
