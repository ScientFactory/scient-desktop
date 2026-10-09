import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";

// Run outside the checkout: neither workspace node_modules nor user state may
// satisfy a missing dependency in the published tarball.
NodeAssert.ok(process.argv[2], "Pass the exact server tarball to qualify");
// eslint-disable-next-line t3code/no-global-process-runtime -- Standalone target-host qualification is outside the Effect application runtime.
const platform = process.platform;
const asset = NodePath.resolve(process.argv[2]);
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-server-qualification-"));
const env = { ...process.env, HOME: root, USERPROFILE: root, NODE_PATH: "" };
for (const key of Object.keys(env)) {
  if (/^(T3CODE_|SCIENT_|VITE_|ELECTRON_)/u.test(key) || key === "NODE_OPTIONS") delete env[key];
}
env.SCIENT_NEXT_HOME = NodePath.join(root, "state");
const run = (command, args, cwd = root) => {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    shell: command === "npm" && platform === "win32",
    env,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  NodeAssert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
let server;
try {
  run("tar", ["-xzf", asset, "-C", root]);
  const installed = NodePath.join(root, "package");
  NodeAssert.ok(NodeFS.existsSync(NodePath.join(installed, "npm-shrinkwrap.json")));
  run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], installed);
  NodeFS.writeFileSync(
    NodePath.join(installed, "qualification.mjs"),
    `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, chmodSync } from 'node:fs';
import { FileFinder } from '@ff-labs/fff-node';
const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas');
assert.ok(createCanvas(2, 2).toBuffer('image/png').length > 0);
assert.ok(require('msgpackr-extract').extractStrings);
const finder = FileFinder.create({ basePath: process.cwd(), disableMmapCache: true, disableContentIndexing: true, aiMode: false });
assert.ok(finder.ok, JSON.stringify(finder));
finder.value.destroy();
const cursor = dirname(require.resolve('@cursor/sdk-' + process.platform + '-' + process.arch + '/package.json'));
for (const file of ['vendor/tree-sitter/binding.node', 'vendor/tree-sitter-bash/binding.node']) assert.ok(require(join(cursor, file)));
const rg = spawnSync(join(cursor, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg'), ['--version'], { encoding: 'utf8', timeout: 10000 });
assert.equal(rg.status, 0, rg.stderr);
assert.match(rg.stdout, /ripgrep/);
// NodePtyAdapter repairs this upstream npm permission issue before spawning.
// A raw native-module probe must apply the same preparation.
if (process.platform !== 'win32') {
  const ptyDir = dirname(require.resolve('node-pty/package.json'));
  const helper = ['build/Release/spawn-helper', 'build/Debug/spawn-helper', 'prebuilds/' + process.platform + '-' + process.arch + '/spawn-helper'].map(path => join(ptyDir, path)).find(existsSync);
  if (helper) chmodSync(helper, 0o755);
}
const { spawn } = require('node-pty');
await Promise.all(Array.from({ length: 10 }, (_, i) => new Promise((resolve, reject) => {
  const token = 'scient-remote-pty-' + i;
  const win = process.platform === 'win32';
  const pty = spawn(win ? 'cmd.exe' : '/bin/sh', win ? ['/d', '/c', 'echo ' + token] : ['-c', 'echo ' + token], { cwd: process.cwd(), cols: 80, rows: 24 });
  let output = '';
  const timeout = setTimeout(() => { pty.kill(); reject(new Error('PTY timed out')); }, 15000);
  pty.onData(data => { output += data; });
  pty.onExit(({ exitCode }) => {
    clearTimeout(timeout);
    try { assert.equal(exitCode, 0); assert.ok(output.includes(token), output); if (win) pty.kill(); resolve(); } catch (error) { reject(error); }
  });
})));
process.stdout.write('Remote native probes: canvas, file search, msgpackr, Cursor helpers and 10 concurrent terminals passed.\\n', () => process.exit(0));
`,
  );
  process.stdout.write(run(process.execPath, ["qualification.mjs"], installed));
  const bin = NodePath.join(installed, "dist/bin.mjs");
  NodeAssert.match(run(process.execPath, [bin, "--help"], installed), /serve/u);
  run(
    process.execPath,
    ["--check", NodePath.join(installed, "dist/service-launcher.mjs")],
    installed,
  );
  const listener = NodeNet.createServer();
  listener.listen(0, "127.0.0.1");
  await NodeEvents.once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  server = NodeChildProcess.spawn(
    process.execPath,
    [
      bin,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      env.SCIENT_NEXT_HOME,
    ],
    { cwd: installed, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  // Pairing output is a credential. Capture it locally without printing it.
  let output = "";
  server.stdout.on("data", (data) => {
    output += data;
  });
  server.stderr.on("data", (data) => {
    output += data;
  });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    NodeAssert.equal(server.exitCode, null, "Installed server exited before readiness");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok && (await response.text()).includes("<html")) {
        ready = true;
        break;
      }
    } catch {
      /* Startup is asynchronous. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  NodeAssert.ok(ready, "Installed server must serve its bundled web client");
  const exited = NodeEvents.once(server, "exit");
  server.kill("SIGTERM");
  const shutdown = setTimeout(() => server.kill("SIGKILL"), 15_000);
  const [code, signal] = await exited;
  clearTimeout(shutdown);
  if (platform !== "win32") {
    NodeAssert.equal(signal, null, "Server must drain without forced termination");
    // NodeRuntime reports a handled signal interruption as 130 after finalizers.
    NodeAssert.equal(code, 130, "Server must complete its handled interruption");
  } else NodeAssert.equal(signal, "SIGTERM", "Windows must terminate the isolated server");
  NodeAssert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/u);
  console.log(
    "Exact server tarball: clean npm install, CLI, service syntax, HTTP startup and shutdown passed.",
  );
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = NodeEvents.once(server, "exit");
    server.kill("SIGKILL");
    await exited;
  }
  NodeFS.rmSync(root, { recursive: true, force: true });
}
