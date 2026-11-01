const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const { decide, readWorkspace } = require("./ci-changes.cjs");
const packages = readWorkspace();

test("every diff runs all test lanes, build and typecheck without a package subset", () => {
  for (const files of [
    [],
    null,
    ["docs/operations/development.md"],
    ["docs/fixtures/scient-chat-plotly.md"],
    ["apps/mobile/src/features/review/reviewModel.ts"],
    ["packages/scient-analytics/src/wireContract.ts"],
    ["apps/web/src/authBootstrap.test.ts"],
    ["apps/server/src/git/GitManager.test.ts"],
    ["packages/contracts/src/setup.ts"],
    ["packages/shared/src/__snapshots__/cross-package.snap"],
    [".github/workflows/ci.yml"],
    ["unknown-root-file"],
  ]) {
    const { outputs } = decide(files, packages, false);
    for (const key of ["typecheck", "build", "test", "test_web", "test_server"])
      assert.equal(outputs[key], true, `${files}: ${key}`);
    assert.equal(outputs.test_packages, "", `${files}: all workspace test tasks`);
  }
});

test("docs and app changes still skip native and release lanes by their exact gates", () => {
  for (const file of ["docs/a.md", "apps/web/src/a.test.ts", "apps/server/src/a.ts"]) {
    const { outputs } = decide([file], packages, false);
    for (const key of ["rust", "mobile_native", "release_smoke"])
      assert.equal(outputs[key], false, `${file}: ${key}`);
  }
  assert.equal(decide(["scripts/release-smoke.ts"], packages, false).outputs.release_smoke, true);
  assert.equal(decide(["packages/shared/src/a.ts"], packages, false).outputs.release_smoke, true);
});

test("Rust covers every tracked crate input, and Rust/toolchain/config files at any depth", () => {
  const tracked = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "native/resource-monitor",
      "native/kde-snap-shot",
      "native/hyprland-snap-shot",
    ],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  assert.ok(tracked.length > 0);
  // Rust-only metadata must not expand the production ownership graph used by release smoke.
  assert.equal(
    decide(["apps/mobile/module/Cargo.toml"], packages, false).outputs.release_smoke,
    false,
  );
  for (const file of [
    ...tracked,
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain",
    "rust-toolchain.toml",
    ".cargo/config.toml",
    "apps/mobile/module/src/main.rs",
    "apps/mobile/module/Cargo.toml",
    "apps/mobile/module/Cargo.lock",
    "apps/mobile/module/rust-toolchain",
    "apps/mobile/module/rust-toolchain.toml",
    "apps/mobile/module/.cargo/config.toml",
    "docs/new-helper.rs",
    "apps/web/src/new\nhelper.rs",
  ])
    assert.equal(decide([file], packages, false).outputs.rust, true, file);
  for (const file of [
    "docs/a.md",
    "apps/web/src/a.ts",
    "apps/mobile/Cargo.toml.md",
    "apps/mobile/rust-toolchain.md",
  ])
    assert.equal(decide([file], packages, false).outputs.rust, false, file);
});

test("unknown paths and missing diffs fail open; main runs every lane", () => {
  for (const [files, full] of [
    [null, false],
    [["unknown-root-file"], false],
    [[".github/workflows/ci.yml"], false],
    [["docs/a.md"], true],
  ]) {
    const { outputs } = decide(files, packages, full);
    for (const [key, value] of Object.entries(outputs)) {
      if (key !== "test_packages" && key !== "mobile_native") assert.equal(value, true, key);
    }
    if (files === null || full || files[0] === ".github/workflows/ci.yml")
      assert.equal(outputs.mobile_native, true);
  }
});

test("the mobile native gate preserves arbitrary filenames and its configuration inputs", () => {
  for (const file of [
    "apps/mobile/Foo\nBar.swift",
    "apps/mobile/src/Module.kt",
    "apps/mobile/build.gradle.kts",
    "apps/mobile/Brewfile",
    "scripts/mobile-native-static-check.ts",
    "package.json",
    ".github/workflows/ci.yml",
  ])
    assert.equal(decide([file], packages, false).outputs.mobile_native, true, file);
  for (const file of ["docs/a.md", "samples/Foo.swift", "apps/mobile/src/a.ts"])
    assert.equal(decide([file], packages, false).outputs.mobile_native, false, file);
});
