const assert = require("node:assert/strict");
const test = require("node:test");
const { decide, readWorkspace } = require("./ci-changes.cjs");
const packages = readWorkspace();
const { scan } = require("./scan-test-dependencies.cjs");
const inventory = require("./ci-test-dependencies.json");

test("every scanned test dependency is current and covered by CI selection", () => {
  const discovered = scan(packages);
  assert.deepEqual(
    discovered,
    inventory,
    "Run node .github/scripts/scan-test-dependencies.cjs --write",
  );
  for (const [consumer, dependencies] of Object.entries(discovered.dependencies)) {
    for (const dependency of dependencies) {
      const pkg = packages.find((item) => item.name === dependency);
      assert.ok(pkg, dependency);
      const selected = decide([`${pkg.dir}/src/changed.ts`], packages, false);
      assert.ok(selected.affected.includes(consumer), `${dependency} must select ${consumer}`);
      const consumerPackage = packages.find((item) => item.name === consumer);
      if (consumer === "@t3tools/web") assert.equal(selected.outputs.test_web, true);
      else if (consumer === "t3") assert.equal(selected.outputs.test_server, true);
      else if (consumerPackage.hasTest) {
        assert.equal(selected.outputs.test, true);
        assert.ok(selected.outputs.test_packages.split(" ").includes(consumer));
      }
    }
  }
  for (const [input, consumers] of Object.entries(discovered.inputs)) {
    const selected = decide(
      [input.endsWith("/") ? `${input}new-fixture.md` : input],
      packages,
      false,
    );
    for (const consumer of consumers)
      assert.ok(selected.affected.includes(consumer), `${input} must select ${consumer}`);
  }
});

test("scanner follows helpers, workspace exports, raw imports, fs paths and glob directories", (t) => {
  const fs = require("node:fs");
  const path = require("node:path");
  const repo = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ci-test-inputs-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  };
  const fixturePackages = ["a", "b", "c", "raw", "fs", "glob"].map((name) => ({
    name: `@fixture/${name}`,
    dir: `packages/${name}`,
    deps: [],
    hasTest: true,
  }));
  for (const pkg of fixturePackages)
    write(
      `${pkg.dir}/package.json`,
      JSON.stringify({ name: pkg.name, exports: { ".": "./src/index.ts" } }),
    );
  write("packages/a/src/a.test.ts", 'import "./helper";');
  write(
    "packages/a/src/helper.ts",
    `
    import "../../b/src/index.ts";
    import "@fixture/c";
    import raw from "../../raw/src/input.txt?raw";
    readFileSync(new URL("../../fs/src/input.txt", import.meta.url));
    globSync(new URL("../../glob/src/*.txt", import.meta.url).pathname);
    const root = new URL("../../../", import.meta.url);
    readFileSync(new URL("../../../docs/read.md", import.meta.url));
    readFile(path.join(fileURLToPath(root), "docs", "async.md"));
    globSync(new URL("../../../docs/corpus/*.md", import.meta.url).pathname);
  `,
  );
  write("packages/b/src/index.ts", 'export * from "./nested.js";');
  write("packages/b/src/nested.ts", 'import "../../c/src/index";');
  for (const name of ["raw", "fs", "glob"]) write(`packages/${name}/src/input.txt`, "fixture");
  write("packages/a/src/test_paths.py", "import helper_py\n");
  write(
    "packages/a/src/helper_py.py",
    'from pathlib import Path\n(Path(__file__).resolve().parents[3] / "docs" / "python.md").read_text()\n',
  );
  write("docs/python.md", "fixture");
  write(
    "packages/c/src/index.ts",
    'readFile(new URL("../../../docs/from-workspace-helper.md", import.meta.url));',
  );
  for (const file of ["read.md", "async.md", "from-workspace-helper.md", "corpus/old.md"])
    write(`docs/${file}`, "fixture");
  const result = scan(fixturePackages, repo);
  assert.deepEqual(result.dependencies["@fixture/a"], [
    "@fixture/b",
    "@fixture/c",
    "@fixture/fs",
    "@fixture/glob",
    "@fixture/raw",
  ]);
  assert.ok(result.inputs["docs/python.md"]?.includes("@fixture/a"));
  for (const input of [
    "docs/read.md",
    "docs/async.md",
    "docs/from-workspace-helper.md",
    "docs/corpus/",
  ])
    assert.ok(result.inputs[input]?.includes("@fixture/a"), input);
});

test("cross-client parity, analytics contract and server/client-runtime regressions select their consumers", () => {
  const mobile = decide(["apps/mobile/src/features/review/reviewModel.ts"], packages, false);
  assert.ok(mobile.outputs.test_packages.split(" ").includes("@t3tools/shared"));
  const web = decide(["apps/web/src/lib/diffRendering.ts"], packages, false);
  assert.ok(web.outputs.test_packages.split(" ").includes("@t3tools/shared"));
  assert.equal(
    decide(["packages/scient-analytics/src/wireContract.ts"], packages, false).outputs.test_web,
    true,
  );
  const client = decide(["packages/client-runtime/src/state/threads.ts"], packages, false);
  assert.equal(client.outputs.test_server, true);
  assert.ok(inventory.dependencies.t3.includes("@t3tools/client-runtime"));
});

test("consumed documentation selects tests before the inert-docs rule", () => {
  assert.equal(
    decide(["docs/fixtures/scient-chat-plotly.md"], packages, false).outputs.test_web,
    true,
  );
  assert.ok(
    decide(["docs/fixtures/scient-chat-diagrams.md"], packages, false)
      .outputs.test_packages.split(" ")
      .includes("@t3tools/desktop"),
  );
  assert.equal(
    decide(["docs/internals/t3-connect-troubleshooting.md"], packages, false).outputs.test_server,
    true,
  );
});

test("web and server changes select cross-package tests without native lanes", () => {
  const web = decide(["apps/web/src/authBootstrap.test.ts"], packages, false).outputs;
  const server = decide(["apps/server/src/git/GitManager.test.ts"], packages, false).outputs;
  assert.equal(web.test_web, true);
  // Server citation tests import web session logic; web tests also load server
  // helpers through their reachable imports. These are real test dependencies.
  assert.equal(web.test_server, true);
  assert.equal(server.test_web, true);
  assert.equal(server.test_server, true);
  assert.equal(web.rust, false);
  assert.equal(server.mobile_native, false);
  // Scripts tests inspect app sources; they must still qualify alongside either app.
  assert.equal(web.test, true);
  assert.equal(server.test, true);
});

test("docs skip product work while unknown paths and missing diffs fail open", () => {
  const docs = decide(["docs/operations/development.md"], packages, false).outputs;
  assert.ok(
    Object.entries(docs).every(([key, value]) => key === "test_packages" || value === false),
  );
  for (const files of [null, ["unknown-root-file"], [".github/workflows/ci.yml"]]) {
    const outputs = decide(files, packages, false).outputs;
    for (const key of [
      "typecheck",
      "build",
      "test",
      "test_web",
      "test_server",
      "rust",
      "release_smoke",
    ])
      assert.equal(outputs[key], true, key);
  }
  assert.equal(decide(null, packages, false).outputs.mobile_native, true);
});

test("main's full mode selects all work including native lint, even for a docs push", () => {
  const outputs = decide(["docs/a.md"], packages, true).outputs;
  assert.ok(
    Object.entries(outputs).every(([key, value]) => key === "test_packages" || value === true),
  );
});

test("shared contracts select their consumers and arbitrary native filenames remain visible", () => {
  const outputs = decide(
    ["packages/contracts/src/orchestrationV2.test.ts"],
    packages,
    false,
  ).outputs;
  assert.equal(outputs.test_web, true);
  assert.equal(outputs.test_server, true);
  assert.equal(decide(["apps/mobile/Foo\nBar.swift"], packages, false).outputs.mobile_native, true);
});
