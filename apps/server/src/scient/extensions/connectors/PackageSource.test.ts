// @effect-diagnostics nodeBuiltinImport:off -- Scratch folders stand in for what npm and uv write.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { generatedManifest } from "./LocalConnectorBundle.ts";
import { bringInPackage, makeRunTool, packageOf, type RunTool } from "./PackageSource.ts";

/** Folders under this path sit on another drive: a rename across it fails as on Windows `D:`. */
const drives = vi.hoisted(() => ({ other: undefined as string | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const driveOf = (path: string) =>
    drives.other !== undefined && path.startsWith(drives.other) ? "other" : "system";
  return {
    ...real,
    rename: async (from: string, to: string) => {
      if (driveOf(from) !== driveOf(to))
        throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${from}'`), {
          code: "EXDEV",
        });
      return real.rename(from, to);
    },
  };
});

const setup = () => {
  drives.other = undefined;
};

const scratch = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-package-"))),
  (folder) => Effect.promise(() => NodeFSP.rm(folder, { recursive: true, force: true })),
);

const write = async (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, path), text);
  }
};

const generated = (command: string, args: ReadonlyArray<string>, name = "acme") =>
  generatedManifest({
    name,
    displayName: "Acme",
    version: "2.3.3",
    command,
    args,
    fixed: {},
    variables: [{ name: "TOKEN", secret: true, required: true }],
  });

/** Plays npm and uv: writes what each would install into the folder it was given. */
const fakeTools =
  (asked: Array<ReadonlyArray<string>> = []): RunTool =>
  (tool, args) =>
    Effect.promise(async () => {
      asked.push(args);
      const at = (flag: string) => args[args.indexOf(flag) + 1]!;
      if (tool === "npm") {
        await write(NodePath.join(at("--prefix"), "node_modules"), {
          "@acme/mcp/package.json": JSON.stringify({
            name: "@acme/mcp",
            version: "2.4.0",
            bin: { mcp: "./bin/server.js" },
          }),
          "@acme/mcp/bin/server.js": "",
          "dep/index.js": "",
        });
        return;
      }
      await write(at("--target"), {
        "acme_mcp/cli.py": "class app:\n    def main():\n        return 0\n",
        "acme_mcp-1.4.0.dist-info/METADATA": [
          "Name: acme-mcp",
          "Version: 1.4.0",
          "Requires-Python: >=3.11",
          "Requires-Dist: httpx>=0.27",
          'Requires-Dist: tomli; python_version < "3.11"',
          'Requires-Dist: rich; extra == "cli"',
          'Requires-Dist: click>=8; python_version >= "3.9" and extra == "CLI"',
          'Requires-Dist: pytest; extra == "test"',
          'Requires-Dist: anyio; extra == "cli" and python_version >= "3.9"',
          'Requires-Dist: uvloop; (extra == "test" or extra == "cli") and sys_platform != "win32"',
          'Requires-Dist: colorama; extra != "cli"',
        ].join("\n"),
        "acme_mcp-1.4.0.dist-info/entry_points.txt":
          "[console_scripts]\nacme-mcp = acme_mcp.cli:app.main\n",
        "bin/acme-mcp": "#!/usr/bin/env python",
      });
    });

describe("package connector code", () => {
  it("reads every runner form a connector names, or says why it can't", () => {
    const of = (command: string, ...args: ReadonlyArray<string>) =>
      packageOf(generated(command, args));
    expect(of("npx", "--yes", "@acme/mcp@2.3.3", "--read-only")).toEqual({
      runner: "npx",
      identifier: "@acme/mcp",
      version: "2.3.3",
      extras: [],
      rest: ["--read-only"],
    });
    // regression: only `npx -y pkg@ver` and `uvx pkg==ver` were read; the rest copied no code.
    expect(of("C:\\nodejs\\npx.cmd", "-y", "@acme/mcp")).toMatchObject({
      identifier: "@acme/mcp",
      version: undefined,
    });
    expect(of("/opt/uv/bin/uvx.exe", "acme-mcp[cli,extra]==1.0")).toMatchObject({
      runner: "uvx",
      identifier: "acme-mcp",
      version: "1.0",
      extras: ["cli", "extra"],
    });
    expect(of("uvx", "--from", "git+https://example.com/acme", "acme")).toMatchObject({
      problem: expect.stringContaining("no other uvx options"),
    });
    expect(of("uvx", "acme>=1")).toMatchObject({
      problem: expect.stringContaining("name==1.2.3"),
    });
    expect(of("node", "server.js")).toBeUndefined();
  });

  it.effect("moves npm's files in on the folder's own drive", () =>
    Effect.gen(function* () {
      setup();
      const chat = yield* scratch;
      drives.other = chat;
      const folder = NodePath.join(chat, "connectors", "acme");
      yield* Effect.promise(() => NodeFSP.mkdir(folder, { recursive: true }));
      const manifest = generated("npx", ["-y", "@acme/mcp"]);
      const pkg = packageOf(manifest);
      if (pkg === undefined || "problem" in pkg) throw new Error("not a package");
      // regression: npm wrote under the system temp folder, and moving across drives failed.
      const source = yield* bringInPackage(folder, manifest, pkg, fakeTools());
      // An unpinned package is brought in at the exact version npm chose.
      expect(source).toContain("@acme/mcp 2.4.0");
      expect(
        yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(folder, "package"))),
      ).toEqual(["bin", "package.json"]);
      expect(yield* Effect.promise(() => NodeFSP.readdir(NodePath.dirname(folder)))).toEqual([
        "acme",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("brings a PyPI package in with its extras' dependencies and dotted entry", () =>
    Effect.gen(function* () {
      setup();
      const folder = NodePath.join(yield* scratch, "acme");
      const manifest = generated("uvx", ["acme-mcp[cli]"], "Acme MCP!");
      const pkg = packageOf(manifest);
      if (pkg === undefined || "problem" in pkg) throw new Error("not a package");
      const asked: Array<ReadonlyArray<string>> = [];
      const source = yield* bringInPackage(folder, manifest, pkg, fakeTools(asked));
      expect(asked[0]).toContain("acme-mcp[cli]");
      expect(source).toContain("acme-mcp 1.4.0");
      const read = (path: string) =>
        Effect.promise(() => NodeFSP.readFile(NodePath.join(folder, path), "utf8"));
      expect(JSON.parse(yield* read("manifest.json")).server.mcp_config).toEqual({
        command: "uv",
        args: ["run", "--project", "${__dirname}", "${__dirname}/server.py"],
        env: { TOKEN: "${user_config.TOKEN}" },
      });
      const project = yield* read("pyproject.toml");
      // regression: the name came as given, and extras' dependencies were dropped (also when the
      // extra came first in the marker).
      expect(project).toContain('name = "acme-mcp-connector"');
      expect(project).toContain('requires-python = ">=3.11"');
      expect(project).toContain(
        'dependencies = ["httpx>=0.27", "tomli; python_version < \\"3.11\\"", "rich", "click>=8; python_version >= \\"3.9\\"", "anyio; python_version >= \\"3.9\\"", "uvloop; sys_platform != \\"win32\\""]',
      );
      // regression: `mod:obj.main` became `from mod import obj.main`.
      const server = yield* read("server.py");
      expect(server).toContain('importlib.import_module("acme_mcp.cli")');
      expect(server).toContain('for name in "app.main".split("."):');
      expect(yield* read("package/acme_mcp/cli.py")).toContain("def main");
    }).pipe(Effect.scoped),
  );

  it.effect("says plainly when npm is not on this computer", () =>
    Effect.gen(function* () {
      const runTool = yield* makeRunTool.pipe(Effect.provide(NodeServices.layer));
      const missing = yield* Effect.flip(
        runTool("npm", ["--version"]).pipe(
          Effect.provideService(HostProcess.Environment, { PATH: "" }),
        ),
      );
      expect(missing.message).toContain("needs npm");
    }),
  );
});
