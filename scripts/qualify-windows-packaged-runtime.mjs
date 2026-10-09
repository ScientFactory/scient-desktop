import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import { runDesktopSmoke } from "../apps/desktop/scripts/smoke-test.mjs";

const packageRoot = NodePath.resolve(process.argv[2] ?? "");
// eslint-disable-next-line t3code/no-global-process-runtime -- Standalone target-host probe runs outside the Effect application runtime.
NodeAssert.equal(process.platform, "win32", "Run this probe on the target Windows host");
NodeAssert.ok(process.argv[2], "Pass the isolated packaged app directory");
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: "" };
delete env.ELECTRON_NO_ASAR;
delete env.NODE_OPTIONS;
const source = `
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const resources = process.argv[1];
const serverRequire = createRequire(join(resources, 'server.asar/node_modules/node-pty/package.json'));
const { spawn } = serverRequire('node-pty');
const cursor = join(resources, 'node_modules/@cursor/sdk-win32-x64');
for (const file of ['vendor/tree-sitter/binding.node', 'vendor/tree-sitter-bash/binding.node']) {
  assert.ok(require(join(cursor, file)), file);
}
const rg = spawnSync(join(cursor, 'bin/rg.exe'), ['--version'], { encoding: 'utf8', timeout: 10000 });
assert.equal(rg.status, 0, rg.stderr);
assert.match(rg.stdout, /ripgrep/);
let finished = 0;
for (let i = 0; i < 10; i++) {
  const token = 'scient-packaged-pty-' + i;
  const terminal = spawn('cmd.exe', ['/d', '/c', 'echo ' + token], { cwd: resources, cols: 80, rows: 24 });
  let output = '';
  terminal.onData(data => { output += data; });
  terminal.onExit(({ exitCode }) => {
    assert.equal(exitCode, 0);
    assert.ok(output.includes(token), output);
    if (++finished === 10) console.log('Packaged Windows runtime: 10 concurrent terminals, Cursor rg and tree-sitter passed.');
  });
}
setTimeout(() => { assert.equal(finished, 10, 'All packaged terminals must finish'); }, 15000).unref();
`;
const probe = NodeChildProcess.spawnSync(
  NodePath.join(packageRoot, "Scient.exe"),
  ["--no-global-search-paths", "--eval", source, NodePath.join(packageRoot, "resources")],
  { cwd: packageRoot, env, encoding: "utf8", timeout: 30000 },
);
process.stdout.write(probe.stdout ?? "");
process.stderr.write(probe.stderr ?? "");
NodeAssert.equal(probe.status, 0, probe.error?.message ?? "Packaged runtime probe failed");
NodeAssert.match(probe.stdout, /10 concurrent terminals.*passed/);

if (process.argv.includes("--launch-smoke")) {
  const profileRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-packaged-smoke-"));
  const smokeEnv = {
    ...process.env,
    SCIENT_NEXT_HOME: NodePath.join(profileRoot, "state"),
    APPDATA: NodePath.join(profileRoot, "appdata"),
    ELECTRON_ENABLE_LOGGING: "1",
  };
  delete smokeEnv.ELECTRON_RUN_AS_NODE;
  delete smokeEnv.ELECTRON_NO_ASAR;
  delete smokeEnv.NODE_OPTIONS;
  const result = await runDesktopSmoke({
    executable: NodePath.join(packageRoot, "Scient.exe"),
    cwd: packageRoot,
    env: smokeEnv,
  });
  process.stdout.write(result.output);
  NodeAssert.ok(
    result.passed,
    "Installed desktop must survive the smoke interval and drain on shutdown",
  );
  NodeFS.rmSync(profileRoot, { recursive: true, force: true });
  console.log("Installed Windows desktop launch smoke passed.");
}
