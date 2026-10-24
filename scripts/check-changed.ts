// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Runs CI's fast checks for this branch's changes: format and lint of the
// changed files, knip, generated GraphQL operations, typecheck of the affected
// packages and their dependents, and the test files beside the changed files.
// CI still runs the full test suites and the jobs listed in the summary.
//
//   vp run check:changed          compare against the merge base with origin/main
//   vp run check:changed <ref>    compare against the merge base with <ref>
//
// Uncommitted and untracked files count. Affected packages come from
// .github/scripts/ci-changes.cjs, the same mapping CI uses to gate its jobs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import ts from "typescript-legacy";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";

const root = NodePath.resolve(import.meta.dirname, "..");
const CODE = /\.[cm]?[jt]sx?$/;

const git = (...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);

const ref = process.argv[2] ?? "origin/main";
const mergeBase = NodeChildProcess.spawnSync("git", ["merge-base", "HEAD", ref], {
  cwd: root,
  encoding: "utf8",
});
if (mergeBase.status !== 0) {
  console.error(
    `check:changed: no merge base with ${ref}. Run \`git fetch origin\` or pass a ref.`,
  );
  process.exit(1);
}
const base = mergeBase.stdout.trim();
// --no-renames lists a rename as its old and new path, as CI does.
// SCIENT-FORK:START literal-git-paths
const untracked = git("ls-files", "--others", "--exclude-standard", "-z");
const files = [
  ...new Set([...git("diff", "--name-only", "--no-renames", "-z", base, "--"), ...untracked]),
].sort();
// SCIENT-FORK:END literal-git-paths

if (files.length === 0) {
  console.log(`check:changed: no changes since ${base.slice(0, 12)}.`);
  process.exit(0);
}

const present = files.filter((file) => NodeFS.existsSync(NodePath.join(root, file)));
const code = present.filter((file) => CODE.test(file));
const packages = readWorkspace();
const { affected, outputs } = decide(files, packages, false);

// Changed test files, and the test files beside a changed source file
// (foo.ts -> foo.test.ts, foo.browser.test.tsx). Vitest's import-graph
// `related` reaches most of a package: one leaf server file pulled in 252 of
// 406 server test files and took 7 minutes. CI runs the rest.
const TEST = /\.test\.[cm]?[jt]sx?$/;
const tests = new Set(code.filter((file) => TEST.test(file)));
for (const file of code) {
  const dir = NodePath.dirname(file);
  const prefix = `${NodePath.basename(file).replace(CODE, "")}.`;
  for (const entry of NodeFS.readdirSync(NodePath.join(root, dir))) {
    if (entry.startsWith(prefix) && TEST.test(entry)) tests.add(NodePath.join(dir, entry));
  }
}

// knip:check takes about 35 s and cannot be scoped to a package. Any code
// change can leave a file, export, or dependency unused (removing the last
// import of a helper does), so it runs whenever code or a manifest changes.
const runKnip = files.some(
  (file) => CODE.test(file) || NodePath.basename(file) === "package.json" || file === "knip.jsonc",
);

// CI's Lint job checks that generated GraphQL operations match their sources.
const graphql = ["apps/server", "packages/source-control-github"].filter((dir) =>
  files.some((file) => file.startsWith(`${dir}/`)),
);

const filters = (names: ReadonlyArray<string>) => names.flatMap((name) => ["--filter", name]);
// SCIENT-FORK:START node-runner-tests
const nodeTests = [...tests].filter((file) => {
  const source = ts.createSourceFile(
    file,
    NodeFS.readFileSync(NodePath.join(root, file), "utf8"),
    ts.ScriptTarget.Latest,
  );
  const importsNodeTest = (node: ts.Node): boolean => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "node:test"
    )
      return true;
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "node:test"
    )
      return true;
    return ts.forEachChild(node, importsNodeTest) === true;
  };
  return importsNodeTest(source);
});
const vitestTests = [...tests].filter((file) => !nodeTests.includes(file));
// SCIENT-FORK:END node-runner-tests
const steps = [
  present.length > 0 && {
    name: "format",
    args: ["fmt", "--check", "--no-error-on-unmatched-pattern", ...present],
  },
  code.length > 0 && { name: "lint", args: ["lint", ...code] },
  runKnip && { name: "knip", args: ["run", "knip:check"] },
  ...graphql.map((dir) => ({
    name: `graphql (${dir})`,
    args: ["run", "--filter", `./${dir}`, "generate", "--check"],
  })),
  affected.length > 0 && {
    name: `typecheck (${affected.length} packages)`,
    args: ["run", "--cache", "--concurrency-limit", "4", ...filters(affected), "typecheck"],
  },
  // From the repo root, the root vite.config.ts hands each file to its package's config.
  vitestTests.length > 0 && {
    name: `test (${vitestTests.length} files)`,
    args: ["test", "run", "--passWithNoTests", ...vitestTests],
  },
  // SCIENT-FORK:START node-runner-tests
  nodeTests.length > 0 && {
    name: `Node test (${nodeTests.length} files)`,
    command: process.execPath,
    args: ["--test", ...nodeTests],
  },
  // SCIENT-FORK:END node-runner-tests
]
  .filter((step) => step !== false)
  .map((step) => ({ command: "vp", ...step }));

console.log(`check:changed: ${files.length} files since ${base.slice(0, 12)}`);
const results = steps.map((step) => {
  console.log(`\n> ${step.command} ${step.name}`);
  const started = performance.now();
  const { status } = NodeChildProcess.spawnSync(step.command, step.args, {
    cwd: root,
    stdio: "inherit",
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  return { name: step.name, ok: status === 0, seconds };
});

console.log("\ncheck:changed summary");
for (const result of results) {
  console.log(`  ${result.ok ? "pass" : "FAIL"}  ${result.name}  ${result.seconds}s`);
}
const ciOnly = Object.entries({
  "full test suites": outputs.test || outputs.test_web || outputs.test_server,
  build: outputs.build,
  rust: outputs.rust,
  "mobile native lint": outputs.mobile_native,
  "release smoke": outputs.release_smoke,
}).flatMap(([job, runs]) => (runs ? [job] : []));
if (ciOnly.length > 0) console.log(`  CI also runs: ${ciOnly.join(", ")}`);
if (!runKnip) console.log("  knip skipped: no code or manifest changed");
if (results.some((result) => !result.ok)) process.exit(1);
