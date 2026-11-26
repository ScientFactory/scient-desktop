import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  bundlesWslRuntime,
  createStageWorkspaceConfig,
  findForbiddenWslRuntimeArchiveMember,
  packWindowsServerAsar,
  resolveWindowsServerAsarIgnoreGlobs,
  validateWindowsPackagedPayload,
  WINDOWS_SERVER_ASAR_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_NAME,
  WSL_RUNTIME_ARCHIVE_NAME,
} from "./build-desktop-artifact.ts";
import { windowsCursorFiles, windowsTranscribeFiles } from "./lib/windows-payload.ts";

const makeSlimWindowsFixture = Effect.fn("test.makeSlimWindowsFixture")(function* (options?: {
  readonly injectLinuxAsarEntry?: boolean;
  readonly injectWslArchive?: boolean;
  readonly omitResourceMonitor?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-slim-win-" });
  const sourceDir = path.join(tempDir, "server-source");
  const serverEntryPath = path.join(sourceDir, "apps/server/dist/bin.mjs");
  const nativePath = path.join(sourceDir, "node_modules/native/addon.node");
  yield* fs.makeDirectory(path.dirname(serverEntryPath), { recursive: true });
  yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
  yield* fs.writeFileString(serverEntryPath, "console.log('server');\n");
  yield* fs.writeFileString(nativePath, "MZ native-binary");

  const generatedAsarPath = path.join(tempDir, WINDOWS_SERVER_ASAR_RESOURCE);
  if (options?.injectLinuxAsarEntry) {
    const linuxNative = path.join(sourceDir, "node_modules/@napi-rs/canvas-linux-x64-gnu/index.js");
    yield* fs.makeDirectory(path.dirname(linuxNative), { recursive: true });
    yield* fs.writeFileString(linuxNative, "module.exports = {};\n");
    // Pack with linuxServerBackend: true so the Linux entry actually lands inside server.asar.
    yield* packWindowsServerAsar({
      sourceDir,
      asarPath: generatedAsarPath,
      arch: "x64",
      linuxServerBackend: true,
    });
  } else {
    yield* packWindowsServerAsar({
      sourceDir,
      asarPath: generatedAsarPath,
      arch: "x64",
      linuxServerBackend: false,
    });
  }

  const stageDistDir = path.join(tempDir, "dist");
  const packagedAppDir = path.join(stageDistDir, "win-unpacked");
  const resourcesDir = path.join(packagedAppDir, "resources");
  yield* fs.makeDirectory(path.join(resourcesDir, "resource-monitor"), { recursive: true });
  yield* fs.makeDirectory(path.join(resourcesDir, "file-exchange"), { recursive: true });
  yield* fs.makeDirectory(path.join(resourcesDir, "synctex-runtime"), { recursive: true });
  yield* fs.copyFile(generatedAsarPath, path.join(resourcesDir, WINDOWS_SERVER_ASAR_RESOURCE));
  yield* fs.copy(
    `${generatedAsarPath}.unpacked`,
    path.join(resourcesDir, `${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked`),
  );
  if (!options?.omitResourceMonitor) {
    yield* fs.writeFileString(
      path.join(resourcesDir, "resource-monitor/scient-resource-monitor.exe"),
      "monitor",
    );
  }
  yield* fs.writeFileString(
    path.join(resourcesDir, "file-exchange/scient-file-publication.exe"),
    "publication",
  );
  for (const file of ["synctex.exe", "provenance.json", "LICENSE.synctex", "LICENSE.zlib"]) {
    yield* fs.writeFileString(path.join(resourcesDir, "synctex-runtime", file), file);
  }
  for (const file of windowsCursorFiles("x64", false).map(
    (name) => `node_modules/@cursor/${name}`,
  )) {
    const target = path.join(resourcesDir, file);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, "component fixture");
  }
  for (const file of windowsTranscribeFiles("x64")) {
    const target = path.join(
      resourcesDir,
      "server.asar.unpacked/node_modules/@transcribe-cpp/win32-x64-cpu-vulkan",
      file,
    );
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, "speech fixture");
  }
  if (options?.injectWslArchive) {
    yield* fs.writeFileString(path.join(resourcesDir, WSL_RUNTIME_ARCHIVE_NAME), "tar");
    yield* fs.writeFileString(
      path.join(resourcesDir, WSL_RUNTIME_ARCHIVE_HASH_NAME),
      "a".repeat(64),
    );
  }
  const appExecutableName = "Scient.exe";
  yield* fs.writeFileString(path.join(packagedAppDir, appExecutableName), "electron");
  return { stageDistDir, packagedAppDir, appExecutableName };
});

const linuxHostLayer = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(HostProcess.Platform, "linux" as NodeJS.Platform),
  Layer.succeed(HostProcess.Architecture, "x64"),
);

describe("Scient WSL runtime archive", () => {
  it("accepts the Linux runtime and the Windows-named sources Linux packages carry", () => {
    assert.isUndefined(
      findForbiddenWslRuntimeArchiveMember([
        "apps/server/dist/bin.mjs",
        "node_modules/@transcribe-cpp/linux-x64-cpu-vulkan/libtranscribe.so",
        "node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node",
        "node_modules/koffi/src/koffi/src/win32.cc",
        "node_modules/node-pty/lib/windowsPtyAgent.js",
      ]),
    );
  });

  it("refuses Windows-only packages, listed or not", () => {
    for (const member of [
      "node_modules/@transcribe-cpp/win32-x64-cpu-vulkan/ggml-vulkan.dll",
      "node_modules/@koromix/koffi-win32-arm64/win32_arm64/koffi.node",
      "node_modules/@example/addon-win32-x64-msvc/addon.node",
      "node_modules/example-win32-x64/index.node",
    ]) {
      assert.strictEqual(findForbiddenWslRuntimeArchiveMember([member]), member);
    }
  });

  it("leaves the archive out when the build omits the WSL runtime, even with a Linux pty.node", () => {
    assert.isFalse(
      bundlesWslRuntime({ arch: "x64", prebuildPath: "/tmp/pty.node", omitRuntime: true }),
    );
    assert.isTrue(
      bundlesWslRuntime({ arch: "x64", prebuildPath: "/tmp/pty.node", omitRuntime: false }),
    );
  });

  it("keeps physical hoisted node_modules while omitting Linux architectures in slim Windows builds", () => {
    const slimConfig = createStageWorkspaceConfig({
      platform: "win",
      arch: "x64",
      hoisted: true,
      linuxServerBackend: false,
    });
    assert.deepStrictEqual(slimConfig.supportedArchitectures, {
      os: ["win32"],
      cpu: ["x64"],
    });
    assert.strictEqual(slimConfig.nodeLinker, "hoisted");

    const slimIgnores = resolveWindowsServerAsarIgnoreGlobs("x64", false);
    assert.include(slimIgnores, "**/node_modules/**/*-linux-*");
    assert.include(slimIgnores, "**/node_modules/node-pty/prebuilds/linux-*");

    const fullIgnores = resolveWindowsServerAsarIgnoreGlobs("x64", true);
    assert.notInclude(fullIgnores, "**/node_modules/**/*-linux-*");
    assert.include(fullIgnores, "**/node_modules/**/*-linux-arm64*");
  });

  it.effect(
    "validates slim Windows payloads and rejects injected WSL archive, Linux ASAR entries, or missing Windows helpers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const clean = yield* makeSlimWindowsFixture();
          const result = yield* validateWindowsPackagedPayload({
            stageDistDir: clean.stageDistDir,
            appExecutableName: clean.appExecutableName,
            targetArch: "x64",
            expectWslRuntime: false,
            linuxServerBackend: false,
          });
          assert.strictEqual(result.packagedAppDir, clean.packagedAppDir);

          const withArchive = yield* makeSlimWindowsFixture({ injectWslArchive: true });
          const archiveFailure = yield* validateWindowsPackagedPayload({
            stageDistDir: withArchive.stageDistDir,
            appExecutableName: withArchive.appExecutableName,
            targetArch: "x64",
            expectWslRuntime: false,
            linuxServerBackend: false,
          }).pipe(Effect.flip);
          assert.strictEqual(archiveFailure.reason, "wsl-runtime-invalid");

          const withLinuxAsar = yield* makeSlimWindowsFixture({ injectLinuxAsarEntry: true });
          const linuxAsarFailure = yield* validateWindowsPackagedPayload({
            stageDistDir: withLinuxAsar.stageDistDir,
            appExecutableName: withLinuxAsar.appExecutableName,
            targetArch: "x64",
            expectWslRuntime: false,
            linuxServerBackend: false,
          }).pipe(Effect.flip);
          assert.strictEqual(linuxAsarFailure.reason, "sidecar-invalid");

          const missingHelper = yield* makeSlimWindowsFixture({ omitResourceMonitor: true });
          const missingFailure = yield* validateWindowsPackagedPayload({
            stageDistDir: missingHelper.stageDistDir,
            appExecutableName: missingHelper.appExecutableName,
            targetArch: "x64",
            expectWslRuntime: false,
            linuxServerBackend: false,
          }).pipe(Effect.flip);
          assert.strictEqual(missingFailure.reason, "resource-monitor-missing");
        }),
      ).pipe(Effect.provide(linuxHostLayer)),
  );
});
