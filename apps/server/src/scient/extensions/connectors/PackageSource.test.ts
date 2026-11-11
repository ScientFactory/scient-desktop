// @effect-diagnostics nodeBuiltinImport:off -- Scratch folders stand in for what npm and uv write.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { generatedManifest } from "./LocalConnectorBundle.ts";
import { bringInPackage, makeRunTool, packageOf, type RunTool } from "./PackageSource.ts";

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

const exists = (path: string) =>
  NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );

const generated = (command: string, args: ReadonlyArray<string>) =>
  generatedManifest({
    name: "acme",
    displayName: "Acme",
    version: "2.3.3",
    command,
    args,
    fixed: {},
    variables: [{ name: "TOKEN", secret: true, required: true }],
  });

/** Plays npm and uv: writes what each would install into the folder it was given. */
const fakeTools: RunTool = (tool, args) =>
  Effect.promise(async () => {
    const at = (flag: string) => args[args.indexOf(flag) + 1]!;
    if (tool === "npm") {
      const modules = NodePath.join(at("--prefix"), "node_modules");
      await write(modules, {
        "@acme/mcp/package.json": JSON.stringify({
          name: "@acme/mcp",
          bin: { mcp: "./bin/server.js" },
        }),
        "@acme/mcp/bin/server.js": "import '../lib/tools.js';",
        "@acme/mcp/lib/tools.js": "export const description = 'Search mail';",
        "@acme/helper/index.js": "",
        "dep/index.js": "",
      });
      await NodeFSP.mkdir(NodePath.join(modules, ".bin"));
      await NodeFSP.symlink("../@acme/mcp/bin/server.js", NodePath.join(modules, ".bin", "mcp"));
      return;
    }
    await write(at("--target"), {
      "acme_mcp/__init__.py": "def main():\n    return 0\n",
      "acme_mcp-1.0.dist-info/METADATA": [
        "Name: acme-mcp",
        "Requires-Python: >=3.11",
        "Requires-Dist: httpx>=0.27",
        'Requires-Dist: tomli; python_version < "3.11"',
        'Requires-Dist: pytest; extra == "test"',
      ].join("\n"),
      "acme_mcp-1.0.dist-info/entry_points.txt": "[console_scripts]\nacme-mcp = acme_mcp:main\n",
      "bin/acme-mcp": "#!/usr/bin/env python",
    });
  });

describe("package connector code", () => {
  it.effect("brings an npm package's code in and runs it from the folder", () =>
    Effect.gen(function* () {
      const folder = yield* scratch;
      const manifest = generated("npx", ["-y", "@acme/mcp@2.3.3", "--read-only"]);
      const pkg = packageOf(manifest)!;
      expect(pkg).toEqual({
        runner: "npx",
        identifier: "@acme/mcp",
        version: "2.3.3",
        rest: ["--read-only"],
      });
      const source = yield* bringInPackage(folder, manifest, pkg, fakeTools);
      expect(source).toContain("package/");
      const written = JSON.parse(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(folder, "manifest.json"), "utf8"),
        ),
      );
      expect(written.server).toEqual({
        type: "node",
        entry_point: "package/bin/server.js",
        mcp_config: {
          command: "node",
          args: ["${__dirname}/package/bin/server.js", "--read-only"],
          env: { TOKEN: "${user_config.TOKEN}" },
        },
      });
      expect(written.user_config).toEqual(manifest.user_config);
      const has = (path: string) => Effect.promise(() => exists(NodePath.join(folder, path)));
      expect(yield* has("package/lib/tools.js")).toBe(true);
      expect(yield* has("node_modules/@acme/helper/index.js")).toBe(true);
      expect(yield* has("node_modules/dep/index.js")).toBe(true);
      // The package itself lives only in package/, and npm's links into it are gone.
      expect(yield* has("node_modules/@acme/mcp")).toBe(false);
      expect(yield* has("node_modules/.bin")).toBe(false);
    }),
  );

  it.effect("brings a PyPI package's code in, with its dependencies for uv", () =>
    Effect.gen(function* () {
      const folder = yield* scratch;
      const manifest = generated("uvx", ["acme-mcp==1.0"]);
      const source = yield* bringInPackage(folder, manifest, packageOf(manifest)!, fakeTools);
      expect(source).toContain("pyproject.toml");
      const read = (path: string) =>
        Effect.promise(() => NodeFSP.readFile(NodePath.join(folder, path), "utf8"));
      expect(JSON.parse(yield* read("manifest.json")).server.mcp_config).toEqual({
        command: "uv",
        args: ["run", "--project", "${__dirname}", "${__dirname}/server.py"],
        env: { TOKEN: "${user_config.TOKEN}" },
      });
      const project = yield* read("pyproject.toml");
      expect(project).toContain('requires-python = ">=3.11"');
      expect(project).toContain(
        'dependencies = ["httpx>=0.27", "tomli; python_version < \\"3.11\\""]',
      );
      expect(yield* read("server.py")).toContain("from acme_mcp import main");
      expect(yield* read("package/acme_mcp/__init__.py")).toContain("def main");
      expect(yield* Effect.promise(() => exists(NodePath.join(folder, "package", "bin")))).toBe(
        false,
      );
    }),
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
