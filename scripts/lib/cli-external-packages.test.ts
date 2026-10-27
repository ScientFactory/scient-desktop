import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import serverPackageJson from "../../apps/server/package.json" with { type: "json" };

import { findEsmImportsOfExternalPackages } from "./cli-executable-imports.ts";

import {
  isRuntimeExternalCliDependency,
  findInlinedExternalPackages,
  shouldBundleCliDependency,
  selectCliRuntimeExternalDependencies,
} from "./cli-external-packages.ts";

// Native bindings live in optionalDependencies; checking dependencies alone misses them.
const PackageManifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type PackageManifest = typeof PackageManifest.Type;

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(PackageManifest));

describe("shouldBundleCliDependency", () => {
  it("bundles ordinary runtime dependencies", () => {
    for (const id of [
      "effect",
      "@effect/platform",
      "hono",
      "@t3tools/shared/HostProcess",
      "zod",
      "zod/v3",
      "zod/v4",
      "zod/v4-mini",
      "@bufbuild/protobuf",
      "@connectrpc/connect",
      "@connectrpc/connect-node",
      "@connectrpc/connect-web",
      "@statsig/js-client",
      "@statsig/client-core",
      "@fastify/busboy",
    ]) {
      assert.strictEqual(shouldBundleCliDependency(id), true, id);
    }
  });

  // regression: 7e01d33f0e perf(build): stop unpacking node_modules wholesale from the Windows asar (#5877)
  it("never bundles node: builtins", () => {
    assert.strictEqual(shouldBundleCliDependency("node:fs"), false);
  });

  it("leaves native addons and their dlopen wrappers external", () => {
    for (const id of [
      "node-pty",
      "@napi-rs/canvas",
      "@napi-rs/canvas-win32-arm64-msvc",
      "ffi-rs",
      "@yuuang/ffi-rs-win32-x64-msvc",
      "@ff-labs/fff-node",
      "@napi-rs/keyring",
      "@clerk/electron-passkeys",
      "msgpackr-extract",
      "@msgpackr-extract/msgpackr-extract-win32-x64",
      "node-addon-api",
    ]) {
      assert.strictEqual(shouldBundleCliDependency(id), false, id);
    }
  });

  it("leaves bun-only entry points external", () => {
    assert.strictEqual(shouldBundleCliDependency("@effect/platform-bun"), false);
    assert.strictEqual(shouldBundleCliDependency("@effect/sql-sqlite-bun"), false);
  });

  it("treats prefix-matched siblings as external", () => {
    assert.strictEqual(shouldBundleCliDependency("node-gyp-build-optional-packages"), false);
  });
});

describe("selectCliRuntimeExternalDependencies", () => {
  it("keeps only runtime-external dependency roots for the Windows sidecar", () => {
    assert.deepStrictEqual(
      selectCliRuntimeExternalDependencies({
        "@effect/platform-bun": "1.0.0",
        "@ff-labs/fff-node": "2.0.0",
        effect: "3.0.0",
        "node-pty": "4.0.0",
      }),
      {
        "@ff-labs/fff-node": "2.0.0",
        "node-pty": "4.0.0",
      },
    );
  });

  it("selects every external root declared by the server", () => {
    assert.deepStrictEqual(
      Object.keys(selectCliRuntimeExternalDependencies(serverPackageJson.dependencies)).sort(),
      [
        // SCIENT-FORK:START — Scient Accounts: the 1Password SDK stays on disk.
        "@1password/sdk",
        // SCIENT-FORK:END
        "@cursor/sdk",
        "@ff-labs/fff-node",
        "@napi-rs/canvas",
        "@napi-rs/keyring",
        "msgpackr-extract",
        "node-pty",
        "playwright-core",
        "undici",
      ],
    );
  });
});

// Found the hard way: node-gyp-build-optional-packages requires detect-libc,
// which was bundled. Windows was fine; WSL got MODULE_NOT_FOUND.
it.layer(NodeServices.layer)("external package dependency closure", (it) => {
  // Read the pnpm store directly: isolation hides transitive names and exports maps can block package.json.
  const readInstalledPackages = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storeDir = path.resolve(
      path.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "../../node_modules/.pnpm",
    );

    // Paths under store files such as lock.yaml raise ENOTDIR, not absence.
    const isPresent = (candidate: string) =>
      fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));

    const installed = new Map<string, PackageManifest>();
    if (!(yield* isPresent(storeDir))) return installed;

    for (const entry of yield* fileSystem.readDirectory(storeDir)) {
      const modulesDir = path.join(storeDir, entry, "node_modules");
      if (!(yield* isPresent(modulesDir))) continue;

      for (const owner of yield* fileSystem.readDirectory(modulesDir)) {
        const names = owner.startsWith("@")
          ? (yield* fileSystem.readDirectory(path.join(modulesDir, owner))).map(
              (scoped) => `${owner}/${scoped}`,
            )
          : [owner];

        for (const name of names) {
          if (installed.has(name)) continue;
          const manifestPath = path.join(modulesDir, name, "package.json");
          if (!(yield* isPresent(manifestPath))) continue;
          installed.set(name, decodeManifest(yield* fileSystem.readFileString(manifestPath)));
        }
      }
    }
    return installed;
  }).pipe(Effect.cached, Effect.runSync);

  const isRuntimeExternal = isRuntimeExternalCliDependency;

  it.effect("finds the runtime-external packages on disk", () =>
    Effect.gen(function* () {
      const installed = yield* readInstalledPackages;
      const found = [...installed.keys()].filter(isRuntimeExternal);

      // read, nothing is checked. These are the packages whose closure
      // actually broke WSL, so require them by name.
      for (const required of ["node-pty", "node-gyp-build-optional-packages", "detect-libc"]) {
        assert.ok(
          found.includes(required),
          `expected ${required} in the pnpm store; the closure check is only meaningful if it can read these (found ${found.length})`,
        );
      }
    }),
  );

  it.effect("keeps native loader dependency families external too", () =>
    Effect.gen(function* () {
      const installed = yield* readInstalledPackages;
      const violations: string[] = [];
      const seen = new Set<string>();
      // Cursor's computed imports use its installed JS dependency tree, proved
      // by the isolated packaged-SDK probe. Those names must also remain
      // bundleable when imported by a different provider in the server graph.
      const queue = [...installed.keys()].filter(
        (name) => isRuntimeExternal(name) && !name.startsWith("@cursor/sdk"),
      );

      for (const name of queue) {
        if (seen.has(name)) continue;
        seen.add(name);

        const manifest = installed.get(name);
        if (!manifest) continue;

        const declared = {
          ...manifest.dependencies,
          ...manifest.optionalDependencies,
          ...manifest.peerDependencies,
        };
        for (const dependency of Object.keys(declared)) {
          if (!isRuntimeExternal(dependency)) {
            violations.push(`${name} -> ${dependency}`);
          }
          if (!seen.has(dependency)) queue.push(dependency);
        }
      }

      assert.deepStrictEqual(
        violations,
        [],
        `these dependencies of external packages would be bundled away and fail to resolve under WSL: ${violations.join(", ")}`,
      );
    }),
  );
});

describe("findInlinedExternalPackages", () => {
  const region = (path: string) => `//#region ${path}
var x = 1;
//#endregion
`;

  it("flags an external package that was inlined", () => {
    const source =
      region("../../node_modules/.pnpm/detect-libc@2.1.2/node_modules/detect-libc/lib/process.js") +
      region(
        "../../node_modules/.pnpm/msgpackr-extract@3.0.4/node_modules/msgpackr-extract/index.js",
      );
    const result = findInlinedExternalPackages(source);

    assert.deepStrictEqual(result.inlined, ["detect-libc", "msgpackr-extract"]);
    assert.strictEqual(result.regionCount, 2);
  });

  it("reports the packages that were inlined, not just the violations", () => {
    const source =
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js") +
      region("../../node_modules/.pnpm/yaml@2.4.0/node_modules/yaml/dist/index.js") +
      region("../../src/server/main.ts");
    const result = findInlinedExternalPackages(source);

    assert.deepStrictEqual(result.inlinedPackages, ["effect", "yaml"]);
    assert.deepStrictEqual(result.inlined, []);
  });

  it("reads the plain `// <path>` markers newer Rolldown emits", () => {
    const source = [
      "// \0rolldown/runtime.js",
      "var x = 1;",
      "// ../../node_modules/.pnpm/node-addon-api@7.1.1/node_modules/node-addon-api/index.js",
      "var y = 2; // trailing comment",
      "// ../../src/server/main.ts",
      "",
    ].join("\n");
    const result = findInlinedExternalPackages(source);

    assert.strictEqual(result.regionCount, 3);
    assert.deepStrictEqual(result.inlined, ["node-addon-api"]);
  });
});

describe("findEsmImportsOfExternalPackages", () => {
  it("flags static and dynamic imports of file-backed packages", () => {
    const source = [
      'import { FileFinder } from "@ff-labs/fff-node";',
      'import * as fs from "fs";',
      'import { createRequire } from "node:module";',
      'const pty = () => import("node-pty");',
      'const data = () => import("@ff-labs/fff-bin-linux-x64-gnu", { with: { type: "json" } });',
      'const lazy = () => import(/* @vite-ignore */ "ffi-rs");',
      'const local = () => import("./chunk-abc.mjs");',
    ].join("\n");

    assert.deepStrictEqual(findEsmImportsOfExternalPackages(source), [
      "@ff-labs/fff-bin-linux-x64-gnu",
      "@ff-labs/fff-node",
      "ffi-rs",
      "node-pty",
    ]);
  });

  it("flags side-effect imports and re-exports too", () => {
    const source = ['import "msgpackr-extract";', 'export { load } from "ffi-rs";'].join("\n");
    assert.deepStrictEqual(findEsmImportsOfExternalPackages(source), [
      "ffi-rs",
      "msgpackr-extract",
    ]);
  });

  it("ignores imports inside generated extension source and comments", () => {
    const source = [
      'const extension = `import { Type } from "typebox";\nimport type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`;',
      '// import "comment-only";',
      "const example = 'import(\"string-only\")';",
      'const interpolated = `source ${import("real-package")}`;',
    ].join("\n");
    assert.deepStrictEqual(findEsmImportsOfExternalPackages(source), ["real-package"]);
  });

  it("allows optional dynamic Bun built-ins but rejects static imports", () => {
    assert.deepStrictEqual(
      findEsmImportsOfExternalPackages('const load = () => import("bun:sqlite");'),
      [],
    );
    assert.deepStrictEqual(
      findEsmImportsOfExternalPackages('import { Database } from "bun:sqlite";'),
      ["bun:sqlite"],
    );
  });

  it("does not mistake createRequire calls for imports", () => {
    const source = 'const { FileFinder } = createRequire(import.meta.url)("@ff-labs/fff-node");';
    assert.deepStrictEqual(findEsmImportsOfExternalPackages(source), []);
  });
});
