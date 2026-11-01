// @effect-diagnostics nodeBuiltinImport:off -- Exercise qualification with real Vite+ subprocesses in a private workspace.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

function setup(version: string) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-live-qualification "));
  const write = (file: string, source: string) => {
    const target = NodePath.join(root, file);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, source);
  };
  write("package.json", '{"type":"module"}\n');
  write(
    "vite.config.ts",
    'export default { test: { projects: ["apps/server", "apps/desktop"] } };\n',
  );
  write("apps/server/vite.config.ts", "export default { test: {} };\n");
  write(
    "apps/desktop/vite.config.ts",
    'throw new Error("Uninstalled desktop workspace must not initialize");\n',
  );
  write(
    "apps/server/src/selected.live.test.ts",
    `
import * as NodeFS from "node:fs";
import { expect, it } from "vite-plus/test";
it("checks the candidate passed to the server suite", () => {
  NodeFS.writeFileSync("selected-suite-ran", "ran");
  expect(process.env.SCIENT_DROID_TEST_BINARY).toBe("synthetic-binary");
  expect(process.env.SCIENT_DROID_TEST_VERSION).toBe("0.249.0");
});
`,
  );
  write(
    "apps/server/src/unselected.test.ts",
    'throw new Error("Unselected server suite must not run");\n',
  );
  write(
    "scripts/lib/managed-runtime-live-tests.ts",
    NodeFS.readFileSync(new URL("./lib/managed-runtime-live-tests.ts", import.meta.url), "utf8"),
  );
  write(
    "run.ts",
    `
import { runLiveTests } from "./scripts/lib/managed-runtime-live-tests.ts";
await runLiveTests({
  label: "Fixture protocol qualification",
  tests: ["apps/server/src/selected.live.test.ts"],
  environment: {
    SCIENT_DROID_TEST_BINARY: "synthetic-binary",
    SCIENT_DROID_TEST_VERSION: ${JSON.stringify(version)},
  },
  platform: process.platform,
});
`,
  );
  NodeFS.mkdirSync(NodePath.join(root, "node_modules"));
  NodeFS.symlinkSync(
    NodePath.join(import.meta.dirname, "node_modules/vite-plus"),
    NodePath.join(root, "node_modules/vite-plus"),
    "junction",
  );
  return {
    run: () =>
      NodeChildProcess.spawnSync(process.execPath, [NodePath.join(root, "run.ts")], {
        cwd: root,
        encoding: "utf8",
      }),
    selectedSuiteRan: () =>
      NodeFS.existsSync(NodePath.join(root, "apps/server/selected-suite-ran")),
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

it.each([
  { version: "0.249.0", status: 0 },
  { version: "wrong-candidate", status: 1 },
])("runs only the server suite and propagates its outcome: $version", ({ version, status }) => {
  using fixture = setup(version);
  const result = fixture.run();
  const output = result.stdout + result.stderr;
  expect(result.error).toBeUndefined();
  expect(output).not.toContain("Uninstalled desktop workspace must not initialize");
  expect(output).not.toContain("Unselected server suite must not run");
  expect(result.status, output).toBe(status);
  expect(fixture.selectedSuiteRan(), output).toBe(true);
  if (status !== 0) {
    expect(output).toContain("Fixture protocol qualification failed with exit code 1");
  }
});
