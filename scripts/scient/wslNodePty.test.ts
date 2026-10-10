import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  stageWslNodePtyPrebuild,
  WslNodePtyManifestReadError,
  WslNodePtyPrebuildMissingError,
} from "./wslNodePty.ts";

it.layer(NodeServices.layer)("WSL node-pty staging", (it) => {
  it.effect.each(
    (["x64", "arm64"] as const).map((arch) => ({
      caseTitle: `stages ${arch} bytes and marker through the stage-local package symlink`,
      arch,
    })),
  )("$caseTitle", ({ arch }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stageAppDir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-wsl-pty-" });
        const nodeModules = path.join(stageAppDir, "node_modules");
        const packageDir = path.join(nodeModules, ".pnpm", "node-pty", "node_modules", "node-pty");
        const prebuildPath = path.join(stageAppDir, "input.node");
        yield* fs.makeDirectory(packageDir, { recursive: true });
        yield* fs.symlink(packageDir, path.join(nodeModules, "node-pty"));
        yield* fs.writeFileString(path.join(packageDir, "package.json"), '{"version":"1.1.0"}');
        yield* fs.writeFileString(prebuildPath, "synthetic-prebuild-bytes");

        yield* stageWslNodePtyPrebuild({ stageAppDir, arch, prebuildPath });

        const prebuildDir = path.join(packageDir, "prebuilds", `linux-${arch}`);
        assert.equal(
          yield* fs.readFileString(path.join(prebuildDir, "pty.node")),
          "synthetic-prebuild-bytes",
        );
        assert.equal(
          yield* fs.readFileString(path.join(prebuildDir, "t3code-wsl-node-pty.json")),
          `{"arch":"${arch}","nodePtyVersion":"1.1.0"}\n`,
        );
        assert.equal(yield* fs.readFileString(prebuildPath), "synthetic-prebuild-bytes");
      }),
    ),
  );

  it.effect("skips absent prebuilds and unsupported architectures without creating a package", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stageAppDir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-wsl-pty-skip-" });
        yield* stageWslNodePtyPrebuild({ stageAppDir, arch: "x64", prebuildPath: undefined });
        yield* stageWslNodePtyPrebuild({
          stageAppDir,
          arch: "universal",
          prebuildPath: "absent.node",
        });
        assert.isFalse(yield* fs.exists(path.join(stageAppDir, "node_modules")));
      }),
    ),
  );

  it.effect("reports the missing prebuild path before accessing the staged package", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stageAppDir = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-wsl-pty-missing-",
        });
        const prebuildPath = path.join(stageAppDir, "missing.node");
        const error = yield* stageWslNodePtyPrebuild({
          stageAppDir,
          arch: "x64",
          prebuildPath,
        }).pipe(Effect.flip);
        assert.instanceOf(error, WslNodePtyPrebuildMissingError);
        assert.equal(error._tag, "WslNodePtyPrebuildMissingError");
        assert.equal(error.message, `WSL node-pty prebuild not found at ${prebuildPath}.`);
      }),
    ),
  );

  it.effect("reports malformed manifests before copying the binary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stageAppDir = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-wsl-pty-manifest-",
        });
        const packageDir = path.join(stageAppDir, "node_modules", "node-pty");
        const manifestPath = path.join(packageDir, "package.json");
        const prebuildPath = path.join(stageAppDir, "input.node");
        yield* fs.makeDirectory(packageDir, { recursive: true });
        yield* fs.writeFileString(manifestPath, '{"version":null}');
        yield* fs.writeFileString(prebuildPath, "synthetic-prebuild-bytes");
        const error = yield* stageWslNodePtyPrebuild({
          stageAppDir,
          arch: "x64",
          prebuildPath,
        }).pipe(Effect.flip);
        assert.instanceOf(error, WslNodePtyManifestReadError);
        const resolvedManifestPath = yield* fs.realPath(manifestPath);
        assert.equal(
          error.message,
          `Could not read node-pty version from ${resolvedManifestPath}.`,
        );
        assert.isFalse(yield* fs.exists(path.join(packageDir, "prebuilds")));
      }),
    ),
  );
});
