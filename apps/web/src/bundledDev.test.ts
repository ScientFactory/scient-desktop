// @effect-diagnostics nodeBuiltinImport:off - builds and executes real dev bundles on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import react from "@vitejs/plugin-react";
import { createServer } from "vite-plus";
// SCIENT-FORK:START — fixtures for restored behavior guards.
import { expect, it, vi } from "vite-plus/test";
// SCIENT-FORK:END

// SCIENT-FORK:START — fixtures for restored behavior guards.
import { warmBundledDevPlugin } from "../vite/warmBundledDev";
// SCIENT-FORK:END

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

// SCIENT-FORK:START — restore the original behavior guard.

// regression: 72bdf1e658 perf(web): pre-bundle startup chunks when a shared dev server starts (#22210)
it("warms the wanted lazy chunk chain and nothing else", async () => {
  const root = "/synthetic-startup";
  const main = `${root}/src/main.tsx?rolldown-lazy`;
  const route = `${root}/src/routes/_chat.tsx?rolldown-lazy`;
  const unrelated = `${root}/src/rare.ts?rolldown-lazy`;
  const warmed: string[] = [];
  let listening: (() => void) | undefined;
  const removeClient = vi.fn(async () => undefined);
  const plugin = warmBundledDevPlugin();
  const configure = plugin.configureServer;
  if (typeof configure !== "function") throw new Error("Expected a configureServer hook");
  Reflect.apply(configure, {}, [
    {
      config: {
        root,
        experimental: { bundledDev: true },
        logger: { info: vi.fn(), warn: vi.fn() },
      },
      httpServer: {
        once: (_event: string, callback: () => void) => {
          listening = callback;
        },
      },
      environments: {
        client: {
          bundledDev: {
            waitForInitialBuildFinish: async () => undefined,
            triggerLazyBundling: async (id: string) => {
              warmed.push(id);
              return { filename: id };
            },
            markPayloadDelivered: vi.fn(),
            devEngine: {
              removeClient,
              moduleGraph: {
                getModuleIds: () => ["bootstrap", ...(warmed.includes(main) ? ["main"] : [])],
                getModuleInfo: (id: string) => ({
                  dynamicallyImportedIds: id === "bootstrap" ? [main, unrelated] : [route],
                }),
              },
            },
          },
        },
      },
    },
  ]);
  expect(warmed).toEqual([]);
  expect(listening).toBeDefined();
  listening!();
  await vi.waitFor(() => expect(removeClient).toHaveBeenCalledOnce());
  expect(warmed).toEqual([main, route]);
  expect(removeClient).toHaveBeenCalledWith("t3code-startup-warmup");
});
// SCIENT-FORK:END

it("initializes React refresh before a shared UI chunk runs in bundled dev", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bootstrap-"));
  const output = NodePath.join(root, "output");
  let resolveBundle!: (files: Map<string, string>) => void;
  let rejectBundle!: (error: unknown) => void;
  const bundled = new Promise<Map<string, string>>((resolve, reject) => {
    resolveBundle = resolve;
    rejectBundle = reject;
  });
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  try {
    await NodeFSP.mkdir(NodePath.join(root, "src/lib"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, "package.json"), '{"type":"module"}');
    for (const file of ["index.html", "src/bootstrap.ts", "src/lib/bootError.ts"]) {
      await NodeFSP.copyFile(new URL(`../${file}`, import.meta.url), NodePath.join(root, file));
    }
    await NodeFSP.writeFile(
      NodePath.join(root, "src/shared.tsx"),
      "export function Shared() { return <div>ready</div>; }",
    );
    await NodeFSP.writeFile(
      NodePath.join(root, "src/main.tsx"),
      `import { Shared } from "./shared";
export const startup = Promise.resolve().then(() => globalThis.onStarted(Shared()));`,
    );

    server = await createServer({
      configFile: false,
      root,
      publicDir: NodeURL.fileURLToPath(new URL("../public", import.meta.url)),
      logLevel: "silent",
      resolve: {
        alias: { react: NodePath.dirname(NodeURL.fileURLToPath(import.meta.resolve("react"))) },
      },
      experimental: { bundledDev: true },
      plugins: [
        react(),
        {
          name: "capture-bootstrap-bundle",
          buildEnd(error) {
            if (error) rejectBundle(error);
          },
          generateBundle(_options, bundle) {
            resolveBundle(
              new Map(
                Object.values(bundle)
                  .filter((file) => file.type === "chunk")
                  .map((file) => [file.fileName, file.code]),
              ),
            );
          },
        },
      ],
      build: {
        rolldownOptions: {
          experimental: { devMode: { lazy: false } },
          output: {
            codeSplitting: {
              groups: [
                { name: "vendor", test: /node_modules|@react-refresh/, priority: 10 },
                { name: "shared-ui", test: /shared\.tsx$/, includeDependenciesRecursively: false },
              ],
            },
          },
        },
      },
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    for (const [file, code] of await bundled) {
      const target = NodePath.join(output, file);
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.writeFile(target, code);
    }

    const runner = NodePath.join(output, "check.mjs");
    await NodeFSP.writeFile(
      runner,
      `import assert from "node:assert/strict";
const started = Promise.withResolvers();
globalThis.window = globalThis;
globalThis.document = {
  createElement: () => ({ relList: { supports: () => true } }),
  getElementById: () => null,
};
globalThis.__rolldown_runtime__ = {
  registerGraph() {},
  registerModule() {},
  createModuleHotContext: () => ({ accept() {} }),
};
globalThis.onStarted = started.resolve;
console.error = (_message, error) => started.reject(error);
await import("./assets/index.js");
const element = await started.promise;
assert.equal(element.props.children, "ready");
assert.equal(typeof window.$RefreshReg$, "function");
console.log("App started with React refresh ready.");`,
    );
    const result = await execFile("node", [runner]);
    expect(result.stdout).toContain("App started with React refresh ready.");
  } finally {
    await server?.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
