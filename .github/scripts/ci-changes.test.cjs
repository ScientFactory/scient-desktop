const assert = require("node:assert/strict");
const test = require("node:test");
const { decide, readWorkspace } = require("./ci-changes.cjs");
const packages = readWorkspace();

test("web-only changes do not select server shards and server-only changes do not select web shards", () => {
  const web = decide(["apps/web/src/authBootstrap.test.ts"], packages, false).outputs;
  const server = decide(["apps/server/src/git/GitManager.test.ts"], packages, false).outputs;
  assert.equal(web.test_web, true);
  assert.equal(web.test_server, false);
  assert.equal(server.test_web, false);
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
