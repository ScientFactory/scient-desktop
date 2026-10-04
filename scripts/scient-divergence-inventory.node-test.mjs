import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { commentIntervals, inspectScientDivergence } from "./scient-divergence-inventory.mjs";

function fixture(t, files) {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-divergence-"));
  t.after(() => NodeFS.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const write = (path, content) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cwd, path), content);
  };
  for (const [path, content] of Object.entries(files)) write(path, content);
  const commit = () => {
    git("add", "-A");
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
    return git("rev-parse", "HEAD").trim();
  };
  const upstream = commit();
  return {
    cwd,
    git,
    write,
    commit,
    upstream,
    inspect: (candidate, extra = {}) =>
      inspectScientDivergence({ cwd, upstream, candidate, ...extra }),
  };
}
const all = (report) => report.files.flatMap((file) => file.findings);
const baselineFor = (report, findings = all(report)) => ({
  schemaVersion: 1,
  upstream: report.upstream,
  entries: findings
    .filter((f) => f.fingerprint)
    .map((f) => ({
      fingerprint: f.fingerprint,
      owner: "Maintainer",
      reason: "Exact bounded debt independently reviewed",
      reviewRecord: "docs/review.md",
      expiresAt: "2026-12-01",
    })),
});

for (const [name, text] of Object.entries({
  string: 'const value = "// SCIENT-FORK:START\\n// SCIENT-FORK:END";\nconst extra = true;\n',
  template: "const value = `// SCIENT-FORK:START\n// SCIENT-FORK:END`;\nconst extra = true;\n",
  regex: String.raw`const value = /\/\/ SCIENT-FORK:START/;` + "\nconst extra = true;\n",
  jsx: "const value = <pre>/* SCIENT-FORK:START */\n/* SCIENT-FORK:END */</pre>;\nconst extra = true;\n",
}))
  NodeTest.test(`does not credit ${name} marker data`, () => {
    const parsed = commentIntervals(name === "jsx" ? "file.tsx" : "file.ts", text);
    NodeAssert.equal(parsed.status, "parsed");
    NodeAssert.deepEqual(parsed.intervals, []);
  });

NodeTest.test("recognizes genuine line, JSDoc and JSX comments; rejects malformed pairs", () => {
  NodeAssert.deepEqual(
    commentIntervals("a.ts", "// SCIENT-FORK:START\nconst x = 1;\n// SCIENT-FORK:END\n").intervals,
    [{ start: 1, end: 3 }],
  );
  NodeAssert.deepEqual(
    commentIntervals(
      "a.ts",
      "/**\n * SCIENT-FORK:START\n */\nconst x = 1;\n/** SCIENT-FORK:END */\n",
    ).intervals,
    [{ start: 2, end: 5 }],
  );
  NodeAssert.deepEqual(
    commentIntervals(
      "a.tsx",
      "const x = <div>{/* SCIENT-FORK:START */}hello{/* SCIENT-FORK:END */}</div>;",
    ).intervals,
    [{ start: 1, end: 1 }],
  );
  for (const text of [
    "// SCIENT-FORK:END\n",
    "// SCIENT-FORK:START\n",
    "// SCIENT-FORK:START\n// SCIENT-FORK:START\n// SCIENT-FORK:END\n",
  ])
    NodeAssert.equal(commentIntervals("a.ts", text).status, "malformed-markers");
  NodeAssert.equal(commentIntervals("a.ts", "const = ;").status, "parser-error");
  NodeAssert.equal(
    commentIntervals("a.md", "```ts\n// SCIENT-FORK:START\n```\n").status,
    "unsupported-language",
  );
});

NodeTest.test("credits only hunks inside real pairs including marker delimiter additions", (t) => {
  const f = fixture(t, { "a.ts": "export const original = 1;\n" });
  f.write(
    "a.ts",
    "export const original = 1;\n// SCIENT-FORK:START\nexport const extra = 2;\n// SCIENT-FORK:END\n",
  );
  let report = f.inspect(f.commit());
  NodeAssert.equal(report.ratchet, "no-new-debt-within-declared-scope");
  NodeAssert.equal(report.counts.marked, 1);
  f.write(
    "a.ts",
    "export const original = 1;\n// SCIENT-FORK:START\nexport const extra = 2;\n// SCIENT-FORK:END\nexport const outside = 3;\n",
  );
  report = f.inspect(f.commit());
  NodeAssert.equal(report.ratchet, "needs-review");
  NodeAssert.equal(report.counts["new-debt"], 1);
});

for (const [name, original, changed, expected] of [
  [
    "inside",
    "// SCIENT-FORK:START\nconst x = 1;\n// SCIENT-FORK:END\n",
    "// SCIENT-FORK:START\n// SCIENT-FORK:END\n",
    "marked",
  ],
  [
    "before",
    "const x = 1;\n// SCIENT-FORK:START\n// SCIENT-FORK:END\n",
    "// SCIENT-FORK:START\n// SCIENT-FORK:END\n",
    "new-debt",
  ],
  [
    "after",
    "// SCIENT-FORK:START\n// SCIENT-FORK:END\nconst x = 1;\n",
    "// SCIENT-FORK:START\n// SCIENT-FORK:END\n",
    "new-debt",
  ],
])
  NodeTest.test(`deletion gap ${name} pair`, (t) => {
    const f = fixture(t, { "a.ts": original });
    f.write("a.ts", changed);
    const findings = all(f.inspect(f.commit()));
    NodeAssert.equal(findings.length, 1);
    NodeAssert.equal(findings[0].kind, "deletion-gap");
    NodeAssert.equal(findings[0].disposition, expected);
  });

NodeTest.test(
  "baseline acknowledges exact hunk debt without allowing an expanded or new condition",
  (t) => {
    const f = fixture(t, {
      "a.ts": "export const a = 1;\n",
      "docs/review.md": "Independent review record.\n",
    });
    f.write("a.ts", "export const a = 1;\nexport const b = 2;\n");
    const candidate = f.commit(),
      report = f.inspect(candidate),
      baseline = baselineFor(report);
    const exact = f.inspect(candidate, { baseline, asOf: "2026-10-05" });
    NodeAssert.equal(exact.counts["reviewed-historical-debt"], 1);
    NodeAssert.equal(exact.ratchet, "no-new-debt-within-declared-scope");
    NodeAssert.equal(exact.status, "advisory");
    f.write(
      "a.ts",
      "export const a = 1;\nexport const b = 2;\nexport const newCondition = true;\n",
    );
    const expanded = f.inspect(f.commit(), { baseline, asOf: "2026-10-05" });
    NodeAssert.equal(expanded.counts["new-debt"], 1);
    NodeAssert.equal(expanded.unmatchedBaseline.length, 1);
  },
);

NodeTest.test(
  "baseline requires upstream identity, committed review, rationale and valid expiry",
  (t) => {
    const f = fixture(t, { "a.ts": "export const a = 1;\n", "docs/review.md": "Review\n" });
    f.write("a.ts", "export const a = 2;\n");
    const candidate = f.commit();
    const baseline = baselineFor(f.inspect(candidate));
    for (const edit of [
      (b) => {
        b.upstream = "0".repeat(40);
      },
      (b) => {
        b.entries[0].owner = "";
      },
      (b) => {
        b.entries[0].reason = "";
      },
      (b) => {
        b.entries[0].expiresAt = "2026-02-31";
      },
      (b) => {
        b.entries[0].expiresAt = "2026-10-04";
      },
      (b) => {
        b.entries[0].reviewRecord = "docs/missing.md";
      },
      (b) => {
        b.entries.push(b.entries[0]);
      },
    ]) {
      const b = structuredClone(baseline);
      edit(b);
      NodeAssert.equal(
        f.inspect(candidate, { baseline: b, asOf: "2026-10-05" }).status,
        "unavailable",
      );
    }
    NodeAssert.equal(f.inspect(candidate, { baseline }).status, "unavailable");
  },
);

NodeTest.test("parser errors and unknown languages cannot be waived with exact baseline", (t) => {
  const f = fixture(t, { "a.ts": "const x = 1;\n", "a.md": "Old\n", "docs/review.md": "Review\n" });
  f.write("a.ts", "const = ;\n");
  f.write("a.md", "// SCIENT-FORK:START\nNew\n// SCIENT-FORK:END\n");
  const candidate = f.commit(),
    original = f.inspect(candidate);
  const report = f.inspect(candidate, { baseline: baselineFor(original), asOf: "2026-10-05" });
  NodeAssert.equal(report.counts.unresolved, 2);
  NodeAssert.equal(report.counts["reviewed-historical-debt"], 0);
  NodeAssert.equal(report.ratchet, "needs-review");
});

NodeTest.test("exact file deletion tombstones remain debt and are tied to the old blob", (t) => {
  const f = fixture(t, { "a.ts": "const x = 1;\n", "docs/review.md": "Review\n" });
  NodeFS.rmSync(NodePath.join(f.cwd, "a.ts"));
  const candidate = f.commit(),
    report = f.inspect(candidate);
  const tombstone = all(report)[0];
  NodeAssert.equal(tombstone.kind, "file-deletion");
  NodeAssert.equal(report.files[0].upstreamBlob.length, 40);
  const accepted = f.inspect(candidate, { baseline: baselineFor(report), asOf: "2026-10-05" });
  NodeAssert.equal(accepted.counts["reviewed-historical-debt"], 1);
});

NodeTest.test("binary, JSON, generated sources and mode changes are separately visible", (t) => {
  const f = fixture(t, {
    "a.json": '{"a":1}\n',
    "binary.ts": Buffer.from([0, 1]),
    "generated.ts": "// @generated do not edit\nconst x = 1;\n",
    "mode.ts": "const x = 1;\n",
  });
  f.write("a.json", '{"a":2}\n');
  f.write("binary.ts", Buffer.from([0, 2]));
  f.write("generated.ts", "// @generated do not edit\nconst x = 2;\n");
  f.git("update-index", "--chmod=+x", "mode.ts");
  // Preserve the staged mode change without git add resetting it on core.filemode hosts.
  f.git("add", "a.json", "binary.ts", "generated.ts");
  f.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "artifacts");
  const report = f.inspect(f.git("rev-parse", "HEAD").trim());
  NodeAssert.deepEqual(
    all(report)
      .map((f) => f.kind)
      .sort(),
    ["binary-content", "generated-content", "mode-change", "unmarkable-artifact"],
  );
});

NodeTest.test(
  "odd UTF-8 filenames and CRLF/no-final-newline work without path/header splitting",
  (t) => {
    const paths = ["space name.ts", "tab\tname.ts", "line\nname.ts", "עברית.ts", "-leading.ts"];
    const f = fixture(t, Object.fromEntries(paths.map((path) => [path, "const a = 1;\r\n"])));
    for (const path of paths)
      f.write(path, "const a = 1;\r\n// SCIENT-FORK:START\r\nconst b = 2;\r\n// SCIENT-FORK:END");
    f.write("new-only.ts", "const c = 3;\n");
    const candidate = f.commit();
    const index = NodeFS.readFileSync(NodePath.join(f.cwd, ".git/index")),
      refs = f.git("show-ref"),
      objects = f.git("count-objects", "-v");
    const report = f.inspect(candidate);
    NodeAssert.equal(report.counts.marked, paths.length);
    NodeAssert.deepEqual(report.candidateOnly, ["new-only.ts"]);
    NodeAssert.equal(f.git("show-ref"), refs);
    NodeAssert.equal(f.git("count-objects", "-v"), objects);
    NodeAssert.deepEqual(NodeFS.readFileSync(NodePath.join(f.cwd, ".git/index")), index);
    NodeAssert.equal(f.git("status", "--porcelain"), "");
    NodeAssert.deepEqual(f.inspect(candidate), report);
  },
);

NodeTest.test("missing/moving refs are unavailable rather than a green empty inventory", (t) => {
  const f = fixture(t, { "a.ts": "const a = 1;\n" });
  NodeAssert.equal(f.inspect("0".repeat(40)).status, "unavailable");
  NodeAssert.equal(f.inspect("HEAD").status, "unavailable");
});

NodeTest.test("a reviewed path does not cover a separate distant new hunk", (t) => {
  const old = Array.from({ length: 20 }, (_, i) => `export const n${i} = ${i};`).join("\n") + "\n";
  const f = fixture(t, { "a.ts": old, "docs/review.md": "Review\n" });
  f.write("a.ts", old.replace("n1 = 1", "n1 = 100"));
  const reviewed = f.inspect(f.commit());
  f.write("a.ts", old.replace("n1 = 1", "n1 = 100").replace("n18 = 18", "n18 = 1800"));
  const report = f.inspect(f.commit(), { baseline: baselineFor(reviewed), asOf: "2026-10-05" });
  NodeAssert.equal(report.counts["reviewed-historical-debt"], 1);
  NodeAssert.equal(report.counts["new-debt"], 1);
});

NodeTest.test("CLI distinguishes advisory debt, ratchet failure and unavailable objects", (t) => {
  const f = fixture(t, { "a.ts": "const a = 1;\n" });
  f.write("a.ts", "const a = 2;\n");
  const candidate = f.commit();
  const script = new URL("./scient-divergence-inventory.mjs", import.meta.url);
  const run = (extra = []) => {
    try {
      return {
        status: 0,
        output: NodeChildProcess.execFileSync(
          process.execPath,
          [script.pathname, "--upstream", f.upstream, "--candidate", candidate, ...extra],
          { cwd: f.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ),
      };
    } catch (error) {
      return { status: error.status, output: error.stdout };
    }
  };
  NodeAssert.equal(run().status, 0);
  NodeAssert.equal(run(["--ratchet"]).status, 1);
  NodeAssert.equal(JSON.parse(run().output).counts["new-debt"], 1);
  NodeAssert.equal(run(["--candidate", "0".repeat(40)]).status, 2);
});

NodeTest.test("nonregular and undecodable content cannot receive source marker credit", (t) => {
  const f = fixture(t, { "a.ts": "const a = 1;\n", "encoding.ts": "const b = 2;\n" });
  NodeFS.rmSync(NodePath.join(f.cwd, "a.ts"));
  // A symlink is an object kind, not a source file to parse or follow.
  NodeChildProcess.execFileSync("ln", ["-s", "// SCIENT-FORK:START", NodePath.join(f.cwd, "a.ts")]);
  f.write("encoding.ts", Buffer.from([0xff, 0xfe, 0x61]));
  const report = f.inspect(f.commit());
  NodeAssert.ok(all(report).some((finding) => finding.kind === "non-regular-content"));
  NodeAssert.ok(
    all(report).some(
      (finding) => finding.kind === "unsupported-encoding" && finding.disposition === "unresolved",
    ),
  );
  NodeAssert.equal(report.counts.marked, 0);
});

NodeTest.test("recognizes END trivia before punctuation and at end of file", () => {
  for (const text of [
    "function f() {\n// SCIENT-FORK:START\nreturn true;\n// SCIENT-FORK:END\n}\n",
    "const f = {\n// SCIENT-FORK:START\nx: true,\n// SCIENT-FORK:END\n};\n",
    "// SCIENT-FORK:START\nconst x = true;\n// SCIENT-FORK:END",
  ]) {
    const result = commentIntervals("a.ts", text);
    NodeAssert.equal(result.status, "parsed");
    NodeAssert.equal(result.intervals.length, 1);
  }
});

NodeTest.test("immutable comparisons ignore local replacement refs", (t) => {
  const f = fixture(t, { "a.ts": "const a = 1;\n" });
  f.write("a.ts", "const a = 2;\n");
  const candidate = f.commit();
  f.git("replace", f.upstream, candidate);
  const refs = f.git("show-ref");
  const report = f.inspect(candidate);
  NodeAssert.equal(report.counts["new-debt"], 1);
  NodeAssert.equal(f.git("show-ref"), refs);
});

NodeTest.test("balanced nested genuine pairs preserve outer and inner intervals", () => {
  const text =
    "// SCIENT-FORK:START\n// SCIENT-FORK:START\nconst x = true;\n// SCIENT-FORK:END\n// SCIENT-FORK:END\n";
  const parsed = commentIntervals("a.ts", text);
  NodeAssert.equal(parsed.status, "parsed");
  NodeAssert.deepEqual(parsed.intervals, [
    { start: 1, end: 5 },
    { start: 2, end: 4 },
  ]);
  const broken = commentIntervals("a.ts", text.replace(/SCIENT-FORK:END/, "ordinary comment"));
  NodeAssert.equal(broken.status, "malformed-markers");
  NodeAssert.deepEqual(broken.intervals, []);
});
