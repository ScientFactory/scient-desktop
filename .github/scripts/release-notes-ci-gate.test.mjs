import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { catalogPath, detectReleaseNotesOnly, isLiteralCatalog } from "./release-notes-ci-gate.mjs";

const catalog = (body) => `import type { ScientReleaseNote } from "./model";
export const SCIENT_RELEASE_NOTES = ${body} as const satisfies readonly ScientReleaseNote[];`;

NodeTest.test("catalog accepts literal copy without evaluating module code", () => {
  NodeAssert.equal(isLiteralCatalog(NodeFS.readFileSync(catalogPath, "utf8")), true);
  NodeAssert.equal(isLiteralCatalog(catalog('[{ title: "https://example.org/*copy*/", },]')), true);
  for (const body of [
    "[process.env]",
    "[...otherNotes]",
    "[{ title: getTitle() }]",
    "[{ title: `interpolated ${value}` }]",
    '[{ [key]: "value" }]',
    '[{ get title() { return "value"; } }]',
    "[{ title: globalThis }]",
  ])
    NodeAssert.equal(isLiteralCatalog(catalog(body)), false, body);
  NodeAssert.equal(isLiteralCatalog(catalog("[]") + "\nrunSomething();"), false);
  NodeAssert.equal(isLiteralCatalog(catalog("[]").replace("import type", "import")), false);
});

NodeTest.test("immutable Git diffs permit only modified notes and existing focused tests", (t) => {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-notes-gate-"));
  t.after(() => NodeFS.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const put = (path, content) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cwd, path), content);
  };
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  git("config", "user.name", "CI gate test");
  git("config", "user.email", "ci@example.invalid");
  git("config", "core.autocrlf", "false");
  put(catalogPath, catalog('[{title: "old"}]'));
  const testPath = "apps/web/src/scient/releaseNotes/model.test.ts";
  put(testPath, "old test");
  const base = commit();
  const detect = (head, event = { before: base }) => detectReleaseNotesOnly({ event, head, cwd });
  NodeAssert.equal(detect(base), false, "empty diff");
  put(catalogPath, catalog('[{title: "new"}]'));
  put(testPath, "updated test");
  const notes = commit();
  for (const event of [
    { before: base },
    { pull_request: { base: { sha: base } } },
    { merge_group: { base_sha: base } },
  ])
    NodeAssert.equal(detect(notes, event), true);
  NodeAssert.equal(detect(notes, {}), false);
  NodeAssert.equal(detect(notes, { before: "0".repeat(40) }), false);
  NodeAssert.equal(detect("invalid"), false);
  for (const path of [
    ".github/workflows/ci.yml",
    "package.json",
    "pnpm-lock.yaml",
    "apps/web/src/scient/releaseNotes/ScientReleaseNotes.tsx",
    "apps/server/src/server.ts",
    "docs/notes.md",
    "unknown",
    "apps/web/src/scient/releaseNotes/new.test.ts",
  ]) {
    git("reset", "--hard", notes);
    put(path, "changed");
    NodeAssert.equal(detect(commit()), false, path);
  }
  git("reset", "--hard", notes);
  git("mv", testPath, "renamed.ts");
  NodeAssert.equal(detect(commit()), false, "rename");
  git("reset", "--hard", notes);
  git("rm", testPath);
  NodeAssert.equal(detect(commit()), false, "deletion");
  git("reset", "--hard", notes);
  git("update-index", "--chmod=+x", catalogPath);
  git("commit", "-qm", "mode change");
  NodeAssert.equal(detect(git("rev-parse", "HEAD")), false, "mode change");
  git("reset", "--hard", notes);
  put(catalogPath, catalog("[...otherNotes]"));
  const code = commit();
  NodeAssert.equal(detect(code), false, "executable head");
  NodeAssert.equal(detect(notes, { before: code }), false, "executable base");
  git("reset", "--hard", base);
  put(testPath, "test only");
  NodeAssert.equal(detect(commit()), false, "no catalog change");
});

NodeTest.test("focused qualification gates every full lane and preserves required contexts", () => {
  const workflow = NodeFS.readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8");
  const jobs = new Map(
    [...workflow.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|(?![\s\S]))/gm)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  for (const [id, body] of jobs) {
    if (["pull_request", "merge_group", "push", "release_notes"].includes(id)) continue;
    NodeAssert.match(body, /needs:.*release_notes/, id);
    if (!["check", "test_web_reused", "test_server_reused"].includes(id))
      NodeAssert.match(body, /if:.*needs.release_notes.outputs.qualified != 'true'/, id);
  }
  for (const id of ["test_web_reused", "test_server_reused"])
    NodeAssert.match(jobs.get(id), /if:.*needs.release_notes.outputs.qualified == 'true' \|\|/, id);
  const focused = jobs.get("release_notes");
  NodeAssert.match(focused, /qualified: \$\{\{ steps.complete.outputs.qualified \}\}/);
  for (const command of [
    "vp fmt --check",
    "vp lint",
    "typecheck",
    "install --with-deps --only-shell chromium",
    "test src/scient/releaseNotes",
  ])
    NodeAssert.ok(focused.indexOf(command) < focused.indexOf('echo "qualified=true"'), command);
  NodeAssert.ok(!focused.includes("continue-on-error") && !focused.includes("always()"));
  NodeAssert.match(
    jobs.get("check"),
    /if: needs.queue_ci.outputs.reused != 'true' && needs.release_notes.outputs.qualified != 'true'/,
  );
});
