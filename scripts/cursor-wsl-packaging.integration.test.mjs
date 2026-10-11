// Cross-package regression: real server ASAR packing plus the actual Desktop fallback service.
import { extractFile, getRawHeader, listPackage, statFile } from "@electron/asar";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as DesktopConfig from "../apps/desktop/src/app/DesktopConfig.ts";
import * as DesktopEnvironment from "../apps/desktop/src/app/DesktopEnvironment.ts";
import * as DesktopWslServerTree from "../apps/desktop/src/wsl/DesktopWslServerTree.ts";
import {
  DESKTOP_EXTRA_RESOURCES,
  ancestorNodeModulesPaths,
  stageAndPackWindowsServerAsar,
} from "./build-desktop-artifact.ts";

it.layer(NodeServices.layer)("Cursor WSL packaged fallback", (it) => {
  it.effect("stages Cursor helpers and extracts the actual Windows archive for WSL fallback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "scient-cursor-windows-package-",
        });
        const sourceDir = path.join(root, "server");
        const cursorSdkResourcesPath = path.join(
          root,
          "app/apps/desktop/prod-resources/cursor-sdk",
        );
        const resourcesPath = path.join(root, "final/resources");
        yield* fs.makeDirectory(resourcesPath, { recursive: true });
        const windowsNativePath = "node_modules/node-pty/prebuilds/win32-x64/pty.node";
        const linuxNativePath = "node_modules/node-pty/prebuilds/linux-x64/pty.node";
        const files = [
          "apps/server/dist/bin.mjs",
          "node_modules/@cursor/sdk/dist/esm/index.js",
          "node_modules/@cursor/sdk-win32-x64/bin/rg.exe",
          "node_modules/@cursor/sdk-win32-x64/vendor/tree-sitter/binding.node",
          "node_modules/@cursor/sdk-linux-x64/bin/rg",
          windowsNativePath,
          linuxNativePath,
        ];
        for (const file of files) {
          const target = path.join(sourceDir, file);
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          // The packer detects Windows addons by their PE signature; Linux
          // prebuilds stay archived for the real WSL extraction service.
          yield* fs.writeFileString(
            target,
            file === windowsNativePath
              ? "MZ"
              : file === linuxNativePath
                ? "\x7fELF"
                : "packaged fixture",
            { mode: 0o755 },
          );
        }
        const asarPath = path.join(resourcesPath, "server.asar");
        yield* stageAndPackWindowsServerAsar({
          sourceDir,
          asarPath,
          arch: "x64",
          cursorSdkResourcesPath,
        });
        const members = listPackage(asarPath, { isPack: false });
        assert.isTrue(statFile(asarPath, windowsNativePath).unpacked);
        assert.equal(
          yield* fs.readFileString(path.join(`${asarPath}.unpacked`, windowsNativePath)),
          "MZ",
        );
        assert.isFalse(Boolean(statFile(asarPath, linuxNativePath).unpacked));
        assert.equal(extractFile(asarPath, linuxNativePath).toString(), "\x7fELF");
        assert.isTrue(members.some((member) => member.endsWith("@cursor/sdk/dist/esm/index.js")));
        assert.isFalse(
          members.some(
            (member) =>
              member.includes("@cursor/sdk-win32-x64") || member.includes("@cursor/sdk-linux-x64"),
          ),
        );
        for (const packagePath of [
          "sdk-win32-x64/bin/rg.exe",
          "sdk-win32-x64/vendor/tree-sitter/binding.node",
          "sdk-linux-x64/bin/rg",
        ]) {
          assert.equal(
            yield* fs.readFileString(path.join(cursorSdkResourcesPath, packagePath)),
            "packaged fixture",
          );
        }
        const resource = DESKTOP_EXTRA_RESOURCES.find((entry) =>
          entry.from.endsWith("/cursor-sdk"),
        );
        if (!resource) return yield* Effect.die("Missing Cursor extraResources mapping.");
        yield* fs.copy(cursorSdkResourcesPath, path.join(resourcesPath, resource.to));

        // Plain Node lacks Electron's archive filesystem. Read real ASAR bytes through
        // the packer's codec while keeping the actual extraction/publication service.
        const archiveInfo = yield* fs.stat(asarPath);
        const archiveMember = (target) =>
          target === asarPath
            ? ""
            : target.startsWith(`${asarPath}${path.sep}`)
              ? path.relative(asarPath, target)
              : undefined;
        const archiveEntry = (member) =>
          member === "" ? getRawHeader(asarPath).header : statFile(asarPath, member);
        const archiveFs = FileSystem.FileSystem.of({
          ...fs,
          stat: (target) => {
            const member = archiveMember(target);
            if (member === undefined) return fs.stat(target);
            return Effect.sync(() => {
              const entry = archiveEntry(member);
              return {
                ...archiveInfo,
                type: "files" in entry ? "Directory" : "File",
                mode: "executable" in entry && entry.executable ? 0o755 : 0o644,
                size: ByteSize.bytes("size" in entry ? entry.size : 0),
              };
            });
          },
          readDirectory: (target) => {
            const member = archiveMember(target);
            if (member === undefined) return fs.readDirectory(target);
            return Effect.sync(() => {
              const entry = archiveEntry(member);
              if (!("files" in entry)) throw new Error(`Expected archive directory: ${member}`);
              return Object.keys(entry.files);
            });
          },
          readFile: (target) => {
            const member = archiveMember(target);
            return member === undefined
              ? fs.readFile(target)
              : Effect.sync(() => extractFile(asarPath, member));
          },
        });
        const nativeServices = Layer.mergeAll(
          NodeServices.layer,
          DesktopConfig.layerTest({ SCIENT_NEXT_HOME: root, T3CODE_MODE: "desktop" }),
        );
        const environmentLayer = DesktopEnvironment.layer({
          dirname: "/repo/apps/desktop/src",
          homeDirectory: root,
          platform: "win32",
          processArch: "x64",
          appVersion: "1.2.3",
          appPath: "/repo",
          isPackaged: true,
          resourcesPath,
          runningUnderArm64Translation: false,
        }).pipe(Layer.provide(nativeServices));
        const result = yield* Effect.gen(function* () {
          const tree = yield* DesktopWslServerTree.DesktopWslServerTree;
          return yield* tree.ensure;
        }).pipe(
          Effect.provide(
            DesktopWslServerTree.layer.pipe(
              Layer.provide(
                Layer.merge(environmentLayer, Layer.succeed(FileSystem.FileSystem, archiveFs)),
              ),
            ),
          ),
        );
        if (!result.ok) return yield* Effect.die(result.reason);
        assert.include(result.root, path.join("wsl-server-tree", "1.2.3"));
        const fallbackHelper = path.join(result.root, "node_modules/@cursor/sdk-linux-x64/bin/rg");
        assert.equal(yield* fs.readFileString(fallbackHelper), "packaged fixture");
        assert.equal((yield* fs.stat(fallbackHelper)).mode & 0o777, 0o755);
        assert.isFalse(
          yield* fs.exists(path.join(result.root, "node_modules/@cursor/sdk-win32-x64")),
        );
        assert.equal(yield* fs.readFileString(path.join(result.root, linuxNativePath)), "\x7fELF");
        assert.equal(
          yield* fs.readFileString(path.join(result.root, "apps/server/dist/bin.mjs")),
          "packaged fixture",
        );
        assert.equal(
          yield* fs.readFileString(
            path.join(result.root, "node_modules/@cursor/sdk/dist/esm/index.js"),
          ),
          "packaged fixture",
        );
        assert.include(
          yield* fs.readFileString(path.join(result.root, "t3code-wsl-server-tree.json")),
          '"payloadRevision":2',
        );
        // This is the SDK's ancestor lookup from the actual fallback entrypoint.
        const lookup = ancestorNodeModulesPaths(
          path.dirname(path.join(result.root, "apps/server/dist/bin.mjs")),
          path.sep,
        );
        assert.include(lookup, path.join(result.root, "node_modules"));
        assert.isTrue(
          yield* fs.exists(path.join(result.root, "node_modules/@cursor/sdk-linux-x64/bin/rg")),
        );
      }),
    ),
  );
});
