// @effect-diagnostics nodeBuiltinImport:off
import { createPackage } from "@electron/asar";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, expect, it } from "vite-plus/test";

const tool = NodeURL.fileURLToPath(new URL("./native-server-compile-cache.mjs", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

// Node stands in for the packaged engine, which reads the server archive as a directory.
function makeStagedApp() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-native-cache-")),
  );
  roots.push(root);
  const appDir = NodePath.join(root, "staged");
  const resources = NodePath.join(appDir, "resources");
  const dist = NodePath.join(resources, "server.asar/apps/server/dist");
  const desktop = NodePath.join(resources, "app.asar/apps/desktop/dist-electron");
  NodeFS.mkdirSync(dist, { recursive: true });
  NodeFS.mkdirSync(desktop, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(dist, "binCli-fixture.mjs"),
    "export const answer = 42; export const loadServer = () => import('./server-fixture.mjs');",
  );
  NodeFS.writeFileSync(NodePath.join(dist, "server-fixture.mjs"), "export const answer = 43;");
  NodeFS.writeFileSync(
    NodePath.join(dist, "bin.mjs"),
    "throw new Error('The entry must not run');",
  );
  const source = (file: string) =>
    JSON.stringify(NodeURL.fileURLToPath(new URL(file, import.meta.url)));
  NodeFS.writeFileSync(
    NodePath.join(desktop, "serverCompileCache.cjs"),
    `module.exports = require(${source("./lib/server-compile-cache.ts")});`,
  );
  NodeFS.writeFileSync(
    NodePath.join(desktop, "compileCache.cjs"),
    `require(${source("../apps/desktop/src/compileCache.ts")});`,
  );
  return { root, appDir, resources, dist };
}

// Runs the tool as a Linux target host, with Node in place of its packaged executable.
function run(code: string) {
  const host = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-linux-host-"));
  roots.push(host);
  const linux = NodePath.join(host, "linux.cjs");
  NodeFS.writeFileSync(linux, `Object.defineProperty(process, "platform", { value: "linux" });`);
  return NodeChildProcess.spawnSync(
    process.execPath,
    [
      "--require",
      linux,
      "--input-type=module",
      "-e",
      `import * as Module from "node:module";
      import ChildProcess from "node:child_process";
      const spawn = ChildProcess.spawnSync;
      ChildProcess.spawnSync = (executable, args, options) =>
        spawn(process.execPath, ["--require", ${JSON.stringify(linux)}, ...args], options);
      Module.syncBuiltinESMExports();
      const tool = await import(${JSON.stringify(NodeURL.pathToFileURL(tool).href)});
      ${code}`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, NODE_COMPILE_CACHE: undefined, NODE_DISABLE_COMPILE_CACHE: undefined },
    },
  );
}

it("generates bytecode on the target host that a cross-built app installs and its engine accepts", async () => {
  const staged = makeStagedApp();
  const output = NodePath.join(staged.root, "output");
  const generated = run(
    `await tool.generateNativeServerCompileCache({ appDir: ${JSON.stringify(staged.appDir)}, executable: "fixture", output: ${JSON.stringify(output)} });`,
  );
  expect(generated.status, generated.stderr).toBe(0);
  const receipt = JSON.parse(NodeFS.readFileSync(NodePath.join(output, "receipt.json"), "utf8"));
  expect(receipt).toMatchObject({ schemaVersion: 1, platform: "linux" });
  expect(receipt.runtime).toContain(`-linux-${receipt.arch}-`);
  expect(Object.keys(receipt.modules).sort()).toEqual([
    "server.asar/apps/server/dist/binCli-fixture.mjs",
    "server.asar/apps/server/dist/server-fixture.mjs",
  ]);

  // The packager's copy of the app holds the same server bytes in a real archive.
  const packaged = NodePath.join(staged.root, "packaged", "resources");
  NodeFS.mkdirSync(packaged, { recursive: true });
  await createPackage(
    NodePath.join(staged.resources, "server.asar"),
    NodePath.join(packaged, "server.asar"),
  );
  const electronVersion = receipt.runtime.slice(0, receipt.runtime.indexOf("-v"));
  const install = (appOutDir: string, overrides = "") =>
    run(
      `await tool.installNativeServerCompileCache({ appOutDir: ${JSON.stringify(appOutDir)}, platform: "linux", arch: ${JSON.stringify(receipt.arch)}, electronVersion: ${JSON.stringify(electronVersion)}, source: ${JSON.stringify(output)}, ${overrides} });`,
    );
  const installed = install(NodePath.dirname(packaged));
  expect(installed.status, installed.stderr).toBe(0);
  expect(installed.stdout).toContain("Installed server bytecode generated natively on linux");
  expect(NodeFS.readdirSync(NodePath.join(packaged, "server-compile-cache")).sort()).toEqual(
    NodeFS.readdirSync(NodePath.join(output, "server-compile-cache")).sort(),
  );

  // Another engine or other server bytes never ship this bytecode.
  NodeFS.rmSync(NodePath.join(packaged, "server-compile-cache"), { recursive: true });
  const otherEngine = install(NodePath.dirname(packaged), `electronVersion: "0.0.1"`);
  expect(otherEngine.status).not.toBe(0);
  expect(otherEngine.stderr).toContain("is not Electron 0.0.1");
  const changed = NodePath.join(staged.root, "changed", "resources");
  NodeFS.mkdirSync(changed, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(staged.dist, "server-fixture.mjs"),
    "export const answer = 44;",
  );
  await createPackage(
    NodePath.join(staged.resources, "server.asar"),
    NodePath.join(changed, "server.asar"),
  );
  const otherBytes = install(NodePath.dirname(changed));
  expect(otherBytes.status).not.toBe(0);
  expect(otherBytes.stderr).toContain("different server.asar/apps/server/dist/server-fixture.mjs");
  expect(NodeFS.existsSync(NodePath.join(changed, "server-compile-cache"))).toBe(false);
});

it("loads modules whose prepared bytecode no longer matches from source, and the check reports it", () => {
  const staged = makeStagedApp();
  const output = NodePath.join(staged.root, "output");
  const generated = run(
    `await tool.generateNativeServerCompileCache({ appDir: ${JSON.stringify(staged.appDir)}, executable: "fixture", output: ${JSON.stringify(output)} });`,
  );
  expect(generated.status, generated.stderr).toBe(0);
  const check = () =>
    run(
      `tool.checkServerCompileCache({ appDir: ${JSON.stringify(staged.appDir)}, executable: "fixture" });`,
    );
  const accepted = check();
  expect(accepted.status, accepted.stderr).toBe(0);
  expect(accepted.stdout).toContain("accepted prepared bytecode for all 2 modules");

  // Same engine, different source: the engine rejects the stale entry and compiles the module.
  NodeFS.writeFileSync(
    NodePath.join(staged.dist, "server-fixture.mjs"),
    "export const answer = 44;",
  );
  const stale = check();
  expect(stale.status).not.toBe(0);
  expect(stale.stderr).toContain(
    "did not accept prepared bytecode for server.asar/apps/server/dist/server-fixture.mjs",
  );
  expect(stale.stderr).not.toContain("Server bytecode check failed");
});
