import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// eslint-disable-next-line t3code/no-global-process-runtime -- Standalone target-host qualification is outside the Effect application runtime.
NodeAssert.equal(process.platform, "linux", "Qualify the WSL payload on a Linux host");
NodeAssert.ok(process.argv[2], "Pass the exact packaged WSL tarball");
const asset = NodePath.resolve(process.argv[2]);
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-wsl-qualification-"));
const env = { ...process.env, HOME: root, NODE_PATH: "" };
for (const key of Object.keys(env)) {
  if (/^(T3CODE_|SCIENT_|VITE_|ELECTRON_)/u.test(key) || key === "NODE_OPTIONS") delete env[key];
}
env.SCIENT_NEXT_HOME = NodePath.join(root, "state");
const run = (command, args) => {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  NodeAssert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
};
let server;
try {
  const members = run("tar", ["-tzf", asset]);
  NodeAssert.doesNotMatch(
    members,
    /node_modules\/(?:@napi-rs\/(?:canvas|keyring)|@cursor\/sdk)-win32-/u,
  );
  run("tar", ["-xzf", asset, "-C", root]);
  // The extracted payload must supply every module; do not install replacements.
  NodeFS.writeFileSync(
    NodePath.join(root, "probe.mjs"),
    `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FileFinder } from '@ff-labs/fff-node';
const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas');
assert.ok(createCanvas(2, 2).toBuffer('image/png').length > 0);
assert.ok(require('@napi-rs/keyring'));
assert.ok(await import('@cursor/sdk'));
const cursor = dirname(require.resolve('@cursor/sdk-linux-' + process.arch + '/package.json'));
for (const file of ['vendor/tree-sitter/binding.node', 'vendor/tree-sitter-bash/binding.node']) assert.ok(require(join(cursor, file)));
const rg = spawnSync(join(cursor, 'bin/rg'), ['--version'], { encoding: 'utf8', timeout: 10000 });
assert.equal(rg.status, 0, rg.stderr);
assert.match(rg.stdout, /ripgrep/);
const finder = FileFinder.create({ basePath: process.cwd(), disableMmapCache: true, disableContentIndexing: true, aiMode: false });
assert.ok(finder.ok, JSON.stringify(finder));
finder.value.destroy();
const { spawn } = require('node-pty');
await Promise.all(Array.from({ length: 10 }, (_, i) => new Promise((resolve, reject) => {
  const token = 'scient-wsl-pty-' + i;
  const pty = spawn('/bin/sh', ['-c', 'echo ' + token], { cwd: process.cwd(), cols: 80, rows: 24 });
  let output = '';
  const timeout = setTimeout(() => { pty.kill(); reject(new Error('PTY timed out')); }, 15000);
  pty.onData(data => { output += data; });
  pty.onExit(({ exitCode }) => {
    clearTimeout(timeout);
    try { assert.equal(exitCode, 0); assert.ok(output.includes(token), output); resolve(); } catch (error) { reject(error); }
  });
})));
process.stdout.write('Packaged WSL canvas, keyring, Cursor, file search and 10 terminals passed.\\n', () => process.exit(0));
`,
  );
  process.stdout.write(run(process.execPath, ["--no-global-search-paths", "probe.mjs"]));
  const bin = NodePath.join(root, "apps/server/dist/bin.mjs");
  NodeAssert.match(run(process.execPath, ["--no-global-search-paths", bin, "--help"]), /serve/u);
  const listener = NodeNet.createServer();
  listener.listen(0, "127.0.0.1");
  await NodeEvents.once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  server = NodeChildProcess.spawn(
    process.execPath,
    [
      "--no-global-search-paths",
      bin,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      env.SCIENT_NEXT_HOME,
    ],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  // Pairing output is private, even in a disposable synthetic profile.
  let output = "";
  server.stdout.on("data", (data) => {
    output += data;
  });
  server.stderr.on("data", (data) => {
    output += data;
  });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    NodeAssert.equal(server.exitCode, null, "WSL server exited before readiness");
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
  NodeAssert.ok(ready, "WSL server must serve its bundled client");
  const exited = NodeEvents.once(server, "exit");
  server.kill("SIGTERM");
  const shutdown = setTimeout(() => server.kill("SIGKILL"), 15_000);
  const [code, signal] = await exited;
  clearTimeout(shutdown);
  NodeAssert.equal(signal, null, "WSL server must drain without forced termination");
  NodeAssert.equal(code, 130, "WSL server must complete its handled interruption");
  NodeAssert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/u);
  console.log("Exact WSL payload CLI, HTTP startup and shutdown passed.");
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = NodeEvents.once(server, "exit");
    server.kill("SIGKILL");
    await exited;
  }
  NodeFS.rmSync(root, { recursive: true, force: true });
}
