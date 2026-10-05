import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
import { commentIntervals, inspectScientDivergence } from "./scient-divergence-inventory.mjs";

function fixture(t, files, symlinks = {}) {
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
  for (const [path, target] of Object.entries(symlinks)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, path)), { recursive: true });
    NodeFS.symlinkSync(target, NodePath.join(cwd, path));
  }
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

NodeTest.test("symlinked CLI executes advisory, ratchet and invalid-input paths", (t) => {
  const f = fixture(t, { "a.ts": "const a = 1;\n" });
  f.write("a.ts", "const a = 2;\n");
  const candidate = f.commit();
  const script = NodeURL.fileURLToPath(
    new URL("./scient-divergence-inventory.mjs", import.meta.url),
  );
  const alias = NodePath.join(f.cwd, "inventory alias.mjs");
  NodeFS.symlinkSync(script, alias);
  const run = (extra = []) => {
    try {
      return {
        status: 0,
        stdout: NodeChildProcess.execFileSync(
          process.execPath,
          [alias, "--upstream", f.upstream, "--candidate", candidate, ...extra],
          { cwd: f.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ),
      };
    } catch (error) {
      return { status: error.status, stdout: error.stdout };
    }
  };
  const advisory = run();
  NodeAssert.equal(advisory.status, 0);
  NodeAssert.equal(JSON.parse(advisory.stdout).counts["new-debt"], 1);
  const ratchet = run(["--ratchet"]);
  NodeAssert.equal(ratchet.status, 1);
  NodeAssert.equal(JSON.parse(ratchet.stdout).ratchet, "needs-review");
  const invalid = run(["--candidate", "missing-object"]);
  NodeAssert.equal(invalid.status, 2);
  NodeAssert.equal(JSON.parse(invalid.stdout).status, "unavailable");
});

NodeTest.test("ordinary imports stay silent and entry-resolution errors fail unavailable", (t) => {
  const f = fixture(t, { "a.ts": "const a = 1;\n" });
  const url = new URL("./scient-divergence-inventory.mjs", import.meta.url).href;
  const load = `await import(${JSON.stringify(url)});`;
  const imported = NodeChildProcess.execFileSync(
    process.execPath,
    ["--input-type=module", "-e", load],
    { cwd: f.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  NodeAssert.equal(imported, "");
  let failure;
  try {
    NodeChildProcess.execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `process.argv[1] = ${JSON.stringify(NodePath.join(f.cwd, "missing-entry"))}; ${load}`,
      ],
      { cwd: f.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    failure = error;
  }
  NodeAssert.equal(failure?.status, 2);
  NodeAssert.match(failure.stderr, /Unable to resolve CLI entry identity/);
  NodeAssert.equal(failure.stdout, "");
});

function removeFixtureBlob(f, oid) {
  const object = NodePath.join(
    f.git("rev-parse", "--absolute-git-dir").trim(),
    "objects",
    oid.slice(0, 2),
    oid.slice(2),
  );
  NodeAssert.equal(f.git("cat-file", "-t", oid).trim(), "blob");
  NodeAssert.ok(NodeFS.existsSync(object));
  NodeFS.unlinkSync(object);
}

function reviewedFixture(f, candidate, upstream = f.upstream) {
  const inspect = (extra = {}) =>
    inspectScientDivergence({ cwd: f.cwd, upstream, candidate, ...extra });
  const initial = inspect();
  NodeAssert.equal(initial.status, "advisory");
  const options = { baseline: baselineFor(initial), asOf: "2026-10-05" };
  const accepted = inspect(options);
  NodeAssert.equal(accepted.ratchet, "no-new-debt-within-declared-scope");
  NodeAssert.equal(accepted.counts["reviewed-historical-debt"], 1);
  NodeAssert.deepEqual(
    all(accepted).map((item) => item.fingerprint),
    all(initial).map((item) => item.fingerprint),
  );
  return { inspect: () => inspect(options), options };
}

NodeTest.test("reviewed tombstone fails closed when only its original blob is missing", (t) => {
  const f = fixture(t, { "a.ts": "const removedOriginal = 731;\n", "docs/review.md": "Review\n" });
  const blob = f.git("rev-parse", `${f.upstream}:a.ts`).trim();
  NodeFS.unlinkSync(NodePath.join(f.cwd, "a.ts"));
  const candidate = f.commit();
  const reviewed = reviewedFixture(f, candidate);
  removeFixtureBlob(f, blob);
  NodeAssert.equal(f.git("cat-file", "-t", f.upstream).trim(), "commit");
  NodeAssert.equal(f.git("cat-file", "-t", candidate).trim(), "commit");
  NodeAssert.match(f.git("ls-tree", "-r", f.upstream), new RegExp(blob));
  NodeAssert.equal(f.git("show", `${candidate}:docs/review.md`), "Review\n");
  const missing = reviewed.inspect();
  NodeAssert.equal(missing.status, "unavailable");
  NodeAssert.equal(missing.ratchet, "unavailable");
  NodeAssert.deepEqual(missing.files, []);
  const baselinePath = NodePath.join(f.cwd, "reviewed-debt.json");
  NodeFS.writeFileSync(baselinePath, JSON.stringify(reviewed.options.baseline));
  const cli = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodeURL.fileURLToPath(new URL("./scient-divergence-inventory.mjs", import.meta.url)),
      "--upstream",
      f.upstream,
      "--candidate",
      candidate,
      "--baseline",
      baselinePath,
      "--as-of",
      reviewed.options.asOf,
      "--ratchet",
    ],
    { cwd: f.cwd, encoding: "utf8" },
  );
  NodeAssert.equal(cli.status, 2);
  NodeAssert.equal(JSON.parse(cli.stdout).ratchet, "unavailable");
});

NodeTest.test("reviewed mode-only debt requires its unchanged blob to remain available", (t) => {
  const f = fixture(t, { "a.ts": "const modeOriginal = 947;\n", "docs/review.md": "Review\n" });
  f.git("update-index", "--chmod=+x", "a.ts");
  f.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "mode-only");
  const candidate = f.git("rev-parse", "HEAD").trim();
  const original = f.git("rev-parse", `${f.upstream}:a.ts`).trim();
  NodeAssert.equal(f.git("rev-parse", `${candidate}:a.ts`).trim(), original);
  const reviewed = reviewedFixture(f, candidate);
  removeFixtureBlob(f, original);
  const missing = reviewed.inspect();
  NodeAssert.equal(missing.status, "unavailable");
  NodeAssert.equal(missing.ratchet, "unavailable");
  NodeAssert.deepEqual(missing.files, []);
});

for (const side of ["upstream", "candidate"])
  NodeTest.test(`reviewed changed symlink requires its ${side} blob`, (t) => {
    const f = fixture(
      t,
      { "docs/review.md": "Review\n" },
      { "link.ts": "original-symlink-target" },
    );
    NodeFS.unlinkSync(NodePath.join(f.cwd, "link.ts"));
    NodeFS.symlinkSync("changed-symlink-target", NodePath.join(f.cwd, "link.ts"));
    const candidate = f.commit();
    const reviewed = reviewedFixture(f, candidate);
    removeFixtureBlob(
      f,
      f.git("rev-parse", `${side === "upstream" ? f.upstream : candidate}:link.ts`).trim(),
    );
    const missing = reviewed.inspect();
    NodeAssert.equal(missing.status, "unavailable");
    NodeAssert.equal(missing.ratchet, "unavailable");
    NodeAssert.deepEqual(missing.files, []);
  });

NodeTest.test("changed Git links remain metadata debt without fetching external commits", (t) => {
  const f = fixture(t, { "docs/review.md": "Review\n" });
  const originalCommit = "1234567890abcdef1234567890abcdef12345678";
  const changedCommit = "abcdef1234567890abcdef1234567890abcdef12";
  f.git("update-index", "--add", "--cacheinfo", `160000,${originalCommit},external`);
  f.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "original gitlink");
  const upstream = f.git("rev-parse", "HEAD").trim();
  f.git("update-index", "--cacheinfo", `160000,${changedCommit},external`);
  f.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "changed gitlink");
  const candidate = f.git("rev-parse", "HEAD").trim();
  for (const oid of [originalCommit, changedCommit])
    NodeAssert.equal(
      NodeChildProcess.spawnSync("git", ["cat-file", "-e", oid], { cwd: f.cwd }).status,
      1,
    );
  const reviewed = reviewedFixture(f, candidate, upstream);
  NodeAssert.equal(all(reviewed.inspect())[0].kind, "non-regular-content");
  NodeAssert.equal(reviewed.inspect().status, "advisory");
});

function formatExceptionsFor(f, candidate, path, format) {
  const initial = f.inspect(candidate);
  const finding = initial.files
    .find((file) => file.path === path)
    .findings.find((item) => item.kind === "unsupported-language");
  const before = f.git("ls-tree", f.upstream, "--", path).split(/\s+/);
  const after = f.git("ls-tree", candidate, "--", path).split(/\s+/);
  return {
    schemaVersion: 1,
    kind: "reviewed-format-exceptions",
    upstream: f.upstream,
    entries: [
      {
        path,
        format,
        upstreamBlob: before[2],
        candidateBlob: after[2],
        upstreamMode: before[0],
        candidateMode: after[0],
        findingFingerprint: finding.fingerprint,
        owner: "Format maintainer",
        reason: "Reviewed the exact Markdown content; no marker parser is available",
        reviewRecord: "docs/review.md",
        reviewBlob: f.git("rev-parse", `${candidate}:docs/review.md`).trim(),
        expiresAt: "2026-12-01",
      },
    ],
  };
}

NodeTest.test(
  "opt-in reviewed format exception credits exact text without hiding parser limits",
  (t) => {
    const f = fixture(t, { "guide.md": "Original\n", "docs/review.md": "Exact content review\n" });
    f.write("guide.md", "Scient addition\n");
    const candidate = f.commit(),
      initial = f.inspect(candidate);
    const formatExceptions = formatExceptionsFor(f, candidate, "guide.md", "markdown");
    const accepted = f.inspect(candidate, { formatExceptions, asOf: "2026-10-05" });
    NodeAssert.equal(initial.counts.unresolved, 1);
    NodeAssert.equal(accepted.status, "advisory");
    NodeAssert.equal(accepted.ratchet, "no-new-debt-within-declared-scope");
    const finding = all(accepted)[0];
    NodeAssert.equal(finding.kind, "unsupported-language");
    NodeAssert.equal(finding.disposition, "reviewed-format-exception");
    NodeAssert.equal(finding.fingerprint, all(initial)[0].fingerprint);
    NodeAssert.equal(finding.formatException.format, "markdown");
    NodeAssert.match(finding.formatException.parserLimit, /no .*parser/i);
    NodeAssert.equal(accepted.counts["reviewed-format-exception"], 1);
    NodeAssert.deepEqual(accepted.unmatchedFormatExceptions, []);
    NodeAssert.deepEqual(f.inspect(candidate), initial);
  },
);

NodeTest.test(
  "format review rejects stale content, modes, fingerprint and changed review record",
  (t) => {
    const f = fixture(t, { "guide.md": "Original\n", "docs/review.md": "Exact review\n" });
    f.write("guide.md", "Reviewed addition\n");
    const candidate = f.commit(),
      formatExceptions = formatExceptionsFor(f, candidate, "guide.md", "markdown");
    for (const mutate of [
      (input) => {
        input.entries[0].findingFingerprint = "0".repeat(64);
      },
      (input) => {
        input.entries[0].upstreamBlob = "0".repeat(40);
      },
      (input) => {
        input.entries[0].candidateBlob = "0".repeat(40);
      },
      (input) => {
        input.entries[0].candidateMode = "100755";
      },
      (input) => {
        input.entries[0].reviewBlob = "0".repeat(40);
      },
    ]) {
      const input = structuredClone(formatExceptions);
      mutate(input);
      NodeAssert.equal(
        f.inspect(candidate, { formatExceptions: input, asOf: "2026-10-05" }).status,
        "unavailable",
      );
    }
    f.write("guide.md", "A new, unreviewed condition\n");
    NodeAssert.equal(
      f.inspect(f.commit(), { formatExceptions, asOf: "2026-10-05" }).status,
      "unavailable",
    );
    f.write("guide.md", "Reviewed addition\n");
    f.write("docs/review.md", "Different review\n");
    NodeAssert.equal(
      f.inspect(f.commit(), { formatExceptions, asOf: "2026-10-05" }).status,
      "unavailable",
    );
  },
);

NodeTest.test(
  "format review requires exact named schema, date, owner, reason and committed UTF-8 review",
  (t) => {
    const f = fixture(t, {
      "guide.md": "Original\n",
      "docs/review.md": "Review\n",
      "outside.md": "Outside\n",
    });
    f.write("guide.md", "Reviewed\n");
    const candidate = f.commit(),
      formatExceptions = formatExceptionsFor(f, candidate, "guide.md", "markdown");
    const edits = [
      (input) => {
        input.kind = "baseline";
      },
      (input) => {
        input.upstream = "0".repeat(40);
      },
      (input) => {
        input.entries.push(input.entries[0]);
      },
      (input) => {
        input.entries[0].format = "arbitrary";
      },
      (input) => {
        input.entries[0].owner = " ";
      },
      (input) => {
        input.entries[0].reason = " ";
      },
      (input) => {
        input.entries[0].expiresAt = "2026-10-04";
      },
      (input) => {
        input.entries[0].expiresAt = "2026-02-30";
      },
      (input) => {
        input.entries[0].reviewRecord = "docs/missing.md";
      },
      (input) => {
        input.entries[0].reviewRecord = "outside.md";
      },
      (input) => {
        input.entries[0].reviewRecord = "docs/../outside.md";
      },
    ];
    for (const edit of edits) {
      const input = structuredClone(formatExceptions);
      edit(input);
      NodeAssert.equal(
        f.inspect(candidate, { formatExceptions: input, asOf: "2026-10-05" }).status,
        "unavailable",
      );
    }
    for (const input of [null, false, [], { ...formatExceptions, entries: null }])
      NodeAssert.equal(
        f.inspect(candidate, { formatExceptions: input, asOf: "2026-10-05" }).status,
        "unavailable",
      );
    for (const asOf of [undefined, "now", "2026-02-30", "2026-12-02"])
      NodeAssert.equal(f.inspect(candidate, { formatExceptions, asOf }).status, "unavailable");
    // Expiry is inclusive and deterministic; never use the machine clock.
    NodeAssert.equal(
      f.inspect(candidate, { formatExceptions, asOf: "2026-12-01" }).counts[
        "reviewed-format-exception"
      ],
      1,
    );
    for (const content of ["", " \n", Buffer.from([0xff]), Buffer.from([0, 65])]) {
      f.write("docs/review.md", content);
      const changed = f.commit();
      const input = structuredClone(formatExceptions);
      input.entries[0].reviewBlob = f.git("rev-parse", `${changed}:docs/review.md`).trim();
      NodeAssert.equal(
        f.inspect(changed, { formatExceptions: input, asOf: "2026-10-05" }).status,
        "unavailable",
      );
    }
  },
);

for (const side of ["upstream", "candidate", "review"])
  NodeTest.test(`format review fails closed with missing ${side} blob`, (t) => {
    const f = fixture(t, {
      "guide.md": "Original missing-blob witness\n",
      "docs/review.md": "Exact review object\n",
    });
    f.write("guide.md", "Reviewed missing-blob witness\n");
    const candidate = f.commit(),
      formatExceptions = formatExceptionsFor(f, candidate, "guide.md", "markdown");
    const entry = formatExceptions.entries[0];
    const oid =
      side === "review"
        ? entry.reviewBlob
        : side === "upstream"
          ? entry.upstreamBlob
          : entry.candidateBlob;
    removeFixtureBlob(f, oid);
    const result = f.inspect(candidate, { formatExceptions, asOf: "2026-10-05" });
    NodeAssert.equal(result.status, "unavailable");
    NodeAssert.equal(result.ratchet, "unavailable");
  });

NodeTest.test(
  "format exception cannot waive binary, encoding, nonregular, deletion or unresolved diff",
  (t) => {
    for (const kind of ["binary", "encoding", "symlink", "deletion", "diff"]) {
      const f = fixture(t, {
        "guide.md": "Original\n",
        "docs/review.md": "Review\n",
        ".gitattributes": kind === "diff" ? "guide.md -diff\n" : "",
      });
      f.write("guide.md", "Reviewed\n");
      const reviewed = f.commit();
      const formatExceptions = formatExceptionsFor(f, reviewed, "guide.md", "markdown");
      if (kind === "binary") f.write("guide.md", Buffer.from([0, 65]));
      if (kind === "encoding") f.write("guide.md", Buffer.from([0xff, 65]));
      if (kind === "symlink") {
        NodeFS.unlinkSync(NodePath.join(f.cwd, "guide.md"));
        NodeFS.symlinkSync("docs/review.md", NodePath.join(f.cwd, "guide.md"));
      }
      if (kind === "deletion") NodeFS.unlinkSync(NodePath.join(f.cwd, "guide.md"));
      const candidate = kind === "diff" ? reviewed : f.commit(),
        input = structuredClone(formatExceptions);
      if (kind !== "deletion") {
        input.entries[0].candidateBlob = f.git("rev-parse", `${candidate}:guide.md`).trim();
        input.entries[0].candidateMode = kind === "symlink" ? "120000" : "100644";
        input.entries[0].findingFingerprint = all(f.inspect(candidate)).find(
          (item) => item.candidateBlob,
        )?.fingerprint;
      }
      const result = f.inspect(candidate, { formatExceptions: input, asOf: "2026-10-05" });
      NodeAssert.equal(result.status, "unavailable", kind);
      NodeAssert.equal(result.ratchet, "unavailable", kind);
    }
  },
);

NodeTest.test(
  "format exceptions do not cover unknown extensions or supported-parser failures",
  (t) => {
    for (const [path, content] of [
      ["a.unknown", "changed\n"],
      ["a.ts", "const = ;"],
      ["a.ts", "// SCIENT-FORK:START\nconst a = 2;\n"],
    ]) {
      const f = fixture(t, {
        [path]: "const a = 1;\n",
        "guide.md": "Original\n",
        "docs/review.md": "Review\n",
      });
      f.write("guide.md", "Reviewed\n");
      f.write(path, content);
      const candidate = f.commit(),
        input = formatExceptionsFor(f, candidate, "guide.md", "markdown");
      const result = f.inspect(candidate, { formatExceptions: input, asOf: "2026-10-05" });
      NodeAssert.equal(result.counts["reviewed-format-exception"], 1);
      NodeAssert.equal(result.counts.unresolved, 1);
      NodeAssert.equal(result.ratchet, "needs-review");
      const attempted = structuredClone(input),
        bad = attempted.entries[0];
      bad.path = path;
      bad.upstreamBlob = f.git("rev-parse", `${f.upstream}:${path}`).trim();
      bad.candidateBlob = f.git("rev-parse", `${candidate}:${path}`).trim();
      bad.findingFingerprint = all(f.inspect(candidate)).find(
        (item) => item.candidateBlob === bad.candidateBlob,
      ).fingerprint;
      NodeAssert.equal(
        f.inspect(candidate, { formatExceptions: attempted, asOf: "2026-10-05" }).status,
        "unavailable",
      );
    }
  },
);

NodeTest.test("format CLI keeps exemption visible and rejects stale or unnamed input", (t) => {
  const f = fixture(t, { "guide.md": "Original\n", "docs/review.md": "Review\n" });
  f.write("guide.md", "Reviewed\n");
  const candidate = f.commit(),
    input = formatExceptionsFor(f, candidate, "guide.md", "markdown");
  const exceptionPath = NodePath.join(f.cwd, "reviewed-formats.json");
  const script = NodeURL.fileURLToPath(
    new URL("./scient-divergence-inventory.mjs", import.meta.url),
  );
  const run = (...extra) =>
    NodeChildProcess.spawnSync(
      process.execPath,
      [script, "--upstream", f.upstream, "--candidate", candidate, "--ratchet", ...extra],
      { cwd: f.cwd, encoding: "utf8" },
    );
  NodeAssert.equal(run().status, 1);
  NodeFS.writeFileSync(exceptionPath, JSON.stringify(input));
  const valid = run("--format-exceptions", exceptionPath, "--as-of", "2026-10-05");
  NodeAssert.equal(valid.status, 0);
  NodeAssert.equal(JSON.parse(valid.stdout).counts["reviewed-format-exception"], 1);
  input.entries[0].findingFingerprint = "0".repeat(64);
  NodeFS.writeFileSync(exceptionPath, JSON.stringify(input));
  NodeAssert.equal(run("--format-exceptions", exceptionPath, "--as-of", "2026-10-05").status, 2);
  NodeFS.writeFileSync(exceptionPath, JSON.stringify(baselineFor(f.inspect(candidate))));
  NodeAssert.equal(run("--format-exceptions", exceptionPath, "--as-of", "2026-10-05").status, 2);
  NodeAssert.equal(run("--format-exceptions").status, 2);
});

NodeTest.test("known-format opt-in remains content-pinned for every declared extension", (t) => {
  for (const [extension, format] of [
    ["md", "markdown"],
    ["yaml", "yaml"],
    ["yml", "yaml"],
    ["sh", "shell"],
    ["bash", "shell"],
    ["css", "css"],
    ["rs", "rust"],
    ["xml", "xml"],
  ]) {
    const path = `owned.${extension}`,
      f = fixture(t, { [path]: "Original\n", "docs/review.md": "Review\n" });
    f.write(path, "Reviewed content\n");
    const candidate = f.commit();
    const input = formatExceptionsFor(f, candidate, path, format);
    const result = f.inspect(candidate, { formatExceptions: input, asOf: "2026-10-05" });
    NodeAssert.equal(result.counts["reviewed-format-exception"], 1, extension);
    NodeAssert.equal(all(result)[0].kind, "unsupported-language");
    NodeAssert.equal(all(result)[0].formatException.format, format);
    NodeAssert.equal(result.ratchet, "no-new-debt-within-declared-scope");
  }
});

NodeTest.test("format exception keeps regular executable mode debt separate", (t) => {
  const f = fixture(t, { "owned.sh": "original\n", "docs/review.md": "Review\n" });
  f.write("owned.sh", "reviewed\n");
  f.git("add", "owned.sh");
  f.git("update-index", "--chmod=+x", "owned.sh");
  f.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "changed regular mode");
  const candidate = f.git("rev-parse", "HEAD").trim(),
    input = formatExceptionsFor(f, candidate, "owned.sh", "shell");
  const result = f.inspect(candidate, { formatExceptions: input, asOf: "2026-10-05" });
  NodeAssert.equal(result.counts["reviewed-format-exception"], 1);
  NodeAssert.equal(result.counts["new-debt"], 1);
  NodeAssert.equal(all(result).find((item) => item.kind === "mode-change").disposition, "new-debt");
  NodeAssert.equal(result.ratchet, "needs-review");
  const baseline = baselineFor(
    result,
    all(result).filter((item) => item.kind === "mode-change"),
  );
  NodeAssert.equal(
    f.inspect(candidate, { formatExceptions: input, baseline, asOf: "2026-10-05" }).ratchet,
    "no-new-debt-within-declared-scope",
  );
});

NodeTest.test(
  "format review cannot credit an original symlink or a nonregular review record",
  (t) => {
    const originalLink = fixture(
      t,
      { "docs/review.md": "Review\n" },
      { "guide.md": "original-link" },
    );
    NodeFS.unlinkSync(NodePath.join(originalLink.cwd, "guide.md"));
    originalLink.write("guide.md", "Regular replacement\n");
    const candidate = originalLink.commit(),
      first = originalLink.inspect(candidate);
    const before = originalLink
      .git("ls-tree", originalLink.upstream, "--", "guide.md")
      .split(/\s+/);
    const after = originalLink.git("ls-tree", candidate, "--", "guide.md").split(/\s+/);
    NodeAssert.ok(all(first).some((item) => item.kind === "non-regular-content"));
    const input = {
      schemaVersion: 1,
      kind: "reviewed-format-exceptions",
      upstream: originalLink.upstream,
      entries: [
        {
          path: "guide.md",
          format: "markdown",
          upstreamBlob: before[2],
          candidateBlob: after[2],
          upstreamMode: before[0],
          candidateMode: after[0],
          findingFingerprint: all(first).find((item) => item.kind === "non-regular-content")
            .fingerprint,
          owner: "Maintainer",
          reason: "Attempted wrong-kind review",
          reviewRecord: "docs/review.md",
          reviewBlob: originalLink.git("rev-parse", `${candidate}:docs/review.md`).trim(),
          expiresAt: "2026-12-01",
        },
      ],
    };
    NodeAssert.equal(
      originalLink.inspect(candidate, { formatExceptions: input, asOf: "2026-10-05" }).status,
      "unavailable",
    );
    const f = fixture(t, { "guide.md": "Original\n", "docs/review.md": "Review\n" });
    f.write("guide.md", "Reviewed\n");
    const regular = f.commit(),
      formats = formatExceptionsFor(f, regular, "guide.md", "markdown");
    NodeFS.unlinkSync(NodePath.join(f.cwd, "docs/review.md"));
    NodeFS.symlinkSync("../guide.md", NodePath.join(f.cwd, "docs/review.md"));
    const linked = f.commit();
    formats.entries[0].reviewBlob = f.git("rev-parse", `${linked}:docs/review.md`).trim();
    NodeAssert.equal(
      f.inspect(linked, { formatExceptions: formats, asOf: "2026-10-05" }).status,
      "unavailable",
    );
  },
);

NodeTest.test(
  "unchanged or mode-only format entries cannot become dormant path exemptions",
  (t) => {
    const f = fixture(t, { "guide.md": "Original\n", "docs/review.md": "Review\n" });
    f.write("guide.md", "Reviewed\n");
    const changed = f.commit(),
      formats = formatExceptionsFor(f, changed, "guide.md", "markdown");
    f.write("guide.md", "Original\n");
    const unchanged = f.commit();
    formats.entries[0].candidateBlob = formats.entries[0].upstreamBlob;
    NodeAssert.equal(
      f.inspect(unchanged, { formatExceptions: formats, asOf: "2026-10-05" }).status,
      "unavailable",
    );
    f.git("update-index", "--chmod=+x", "guide.md");
    f.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "mode only");
    const modeOnly = f.git("rev-parse", "HEAD").trim();
    formats.entries[0].candidateMode = "100755";
    NodeAssert.equal(
      f.inspect(modeOnly, { formatExceptions: formats, asOf: "2026-10-05" }).status,
      "unavailable",
    );
  },
);
