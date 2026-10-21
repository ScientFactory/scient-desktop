// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- This opt-in test validates native release assets at the reviewed network boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { latexEngineEnvironment } from "./latexCommand.ts";
import {
  LatexToolchain,
  latexDriverBinDirectory,
  make as makeLatexToolchain,
} from "./LatexToolchain.ts";
import { LatexArchiveUnpacker, make as makeLatexArchiveUnpacker } from "./LatexArchiveUnpacker.ts";
import { resolveTinyTexAsset, type TinyTexAsset } from "./tinytexManifest.ts";
import { parseSyncTexForwardLocation, parseSyncTexInverseLocations } from "./syncTexOutput.ts";

const RUN_ASSET_SMOKE = process.env.SCIENT_TINYTEX_ASSET_SMOKE === "1";
const SYNCTEX_RUNTIME = process.env.SCIENT_SYNCTEX_RUNTIME;
const SMOKE_TIMEOUT_MS = 15 * 60 * 1_000;
// oxlint-disable-next-line t3code/no-global-process-runtime -- native runner selection happens at collection time, before an Effect runtime exists.
const HOST_PLATFORM = NodeOS.platform();
// oxlint-disable-next-line t3code/no-global-process-runtime -- native runner selection happens at collection time, before an Effect runtime exists.
const HOST_ARCHITECTURE = NodeOS.arch();

interface NativeAsset {
  readonly executable: string;
  readonly binDirectory: string;
  readonly workspace: string;
  readonly archivePath: string;
  readonly asset: TinyTexAsset;
}

/**
 * The real toolchain probe over exactly the environment given, with an empty
 * state directory so no managed install can answer instead.
 */
const probeRealToolchain = (environment: NodeJS.ProcessEnv, stateDirectory: string) =>
  LatexToolchain.use((toolchain) => toolchain.probe(true)).pipe(
    Effect.provide(
      Layer.effect(LatexToolchain, makeLatexToolchain).pipe(
        Layer.provide(ProcessRunner.layer),
        Layer.provide(ServerConfig.layerTest(stateDirectory, stateDirectory)),
        Layer.provide(Layer.succeed(HostProcess.Environment, environment)),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

/**
 * This host's environment with PATH replaced and every default install
 * folder pointed somewhere empty, so a TeX the runner happens to have cannot
 * answer in place of the one under test.
 */
function isolatedEnvironment(pathFolders: ReadonlyArray<string>, empty: string): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !["PATH", "LOCALAPPDATA", "PROGRAMFILES", "SYSTEMDRIVE"].includes(key.toUpperCase()),
    ),
  );
  return {
    ...kept,
    [HOST_PLATFORM === "win32" ? "Path" : "PATH"]: pathFolders.join(NodePath.delimiter),
    LOCALAPPDATA: empty,
    ProgramFiles: empty,
  };
}

/**
 * Spawning by bare name on POSIX reads this process's own PATH, so a scenario
 * holds it for exactly as long as it runs.
 */
const withProcessPath = <A, E, R>(pathValue: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const inherited = process.env.PATH;
      process.env.PATH = pathValue;
      return inherited;
    }),
    () => effect,
    (inherited) =>
      Effect.sync(() => {
        if (inherited === undefined) delete process.env.PATH;
        else process.env.PATH = inherited;
      }),
  );

/**
 * A `latexmk` and a `pdflatex` that exist but fail, as MiKTeX's do without
 * Perl. On Windows a renamed `where.exe` rejects `-v` with a real executable's
 * own error; elsewhere a shell script says so.
 */
async function writeBrokenEngine(directory: string, name: string): Promise<string> {
  if (HOST_PLATFORM === "win32") {
    const target = NodePath.join(directory, `${name}.exe`);
    await NodeFSP.copyFile(
      NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"),
      target,
    );
    return target;
  }
  const target = NodePath.join(directory, name);
  await NodeFSP.writeFile(target, `#!/bin/sh\necho "${name}: needs perl" >&2\nexit 1\n`);
  await NodeFSP.chmod(target, 0o755);
  return target;
}

/**
 * Downloads the exact manifest pin, expands it using the same host `tar` the
 * app uses, starts its real `latexmk`, and proves SyncTeX navigation over its
 * output. `null` where this host has nothing pinned.
 */
async function verifyNativeAsset(temporaryRoot: string): Promise<NativeAsset | null> {
  const lookup = resolveTinyTexAsset(HOST_PLATFORM, HOST_ARCHITECTURE);
  expect(lookup.supported, `No asset is pinned for ${HOST_PLATFORM}-${HOST_ARCHITECTURE}`).toBe(
    true,
  );
  if (!lookup.supported) return null;
  expect(SYNCTEX_RUNTIME, "SCIENT_SYNCTEX_RUNTIME must name the bundled helper").toBeTruthy();
  if (!SYNCTEX_RUNTIME) return null;
  expect(NodeFS.existsSync(SYNCTEX_RUNTIME)).toBe(true);

  const archivePath = NodePath.join(temporaryRoot, lookup.asset.fileName);
  const payloadPath = NodePath.join(temporaryRoot, "payload");
  const response = await fetch(lookup.asset.url);
  expect(response.ok).toBe(true);
  expect(response.body).not.toBeNull();
  if (response.body === null) return null;

  const archive = await NodeFSP.open(archivePath, "wx");
  const digest = NodeCrypto.createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      const owned = Buffer.from(chunk);
      bytes += owned.byteLength;
      digest.update(owned);
      await archive.write(owned);
    }
  } finally {
    await archive.close();
  }
  expect(bytes).toBe(lookup.asset.sizeBytes);
  expect(digest.digest("hex")).toBe(lookup.asset.sha256);

  await NodeFSP.mkdir(payloadPath, { recursive: true });
  const tarCommand =
    HOST_PLATFORM === "win32"
      ? NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";
  const unpacked = NodeChildProcess.spawnSync(
    tarCommand,
    ["-x", "-f", archivePath, "-C", payloadPath],
    { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 10 * 60 * 1_000 },
  );
  expect(unpacked.error).toBeUndefined();
  expect(unpacked.status, unpacked.stderr || unpacked.stdout).toBe(0);

  const executable = NodePath.join(payloadPath, lookup.asset.executableRelativePath);
  expect(NodeFS.existsSync(executable)).toBe(true);
  if (HOST_PLATFORM !== "win32") await NodeFSP.chmod(executable, 0o755);
  const binDirectory = NodePath.dirname(executable);
  const engineEnvironment = {
    ...process.env,
    PATH: `${binDirectory}${NodePath.delimiter}${process.env.PATH ?? ""}`,
  };
  const started = NodeChildProcess.spawnSync(executable, ["-v"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
    env: engineEnvironment,
  });
  expect(started.error).toBeUndefined();
  expect(started.status, started.stderr || started.stdout).toBe(0);
  expect(`${started.stdout}\n${started.stderr}`).toMatch(/latexmk/iu);

  // Prove the exact navigation arrangement used by LatexSyncTex: the
  // immutable PDF is not copied, while an existing same-stem marker lets
  // `synctex` discover the retained index through `-d`.
  const workspace = NodePath.join(temporaryRoot, "workspace");
  const outputDirectory = NodePath.join(temporaryRoot, "output");
  const navigationDirectory = NodePath.join(temporaryRoot, "navigation");
  await NodeFSP.mkdir(workspace, { recursive: true });
  await NodeFSP.mkdir(outputDirectory, { recursive: true });
  await NodeFSP.mkdir(navigationDirectory, { recursive: true });
  const sourcePath = NodePath.join(workspace, "main.tex");
  const chapterDirectory = NodePath.join(workspace, "chapters");
  const bodyPath = NodePath.join(chapterDirectory, "body.tex");
  await NodeFSP.mkdir(chapterDirectory, { recursive: true });
  await NodeFSP.writeFile(
    sourcePath,
    "\\documentclass{article}\n\\begin{document}\n\\input{chapters/body}\n\\end{document}\n",
  );
  await NodeFSP.writeFile(bodyPath, "First line.\nSecond line.\nHello Scient.\n");
  const compiled = NodeChildProcess.spawnSync(
    executable,
    [
      "-pdf",
      "-synctex=1",
      "-interaction=nonstopmode",
      `-outdir=${outputDirectory}`,
      NodePath.basename(sourcePath),
    ],
    {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 2 * 60_000,
      env: engineEnvironment,
    },
  );
  expect(compiled.error).toBeUndefined();
  expect(compiled.status, compiled.stderr || compiled.stdout).toBe(0);
  const producedIndex = NodeFS.existsSync(NodePath.join(outputDirectory, "main.synctex.gz"))
    ? NodePath.join(outputDirectory, "main.synctex.gz")
    : NodePath.join(outputDirectory, "main.synctex");
  expect(NodeFS.existsSync(producedIndex)).toBe(true);
  const retainedIndex = NodePath.join(
    navigationDirectory,
    `main.synctex${producedIndex.endsWith(".gz") ? ".gz" : ""}`,
  );
  await NodeFSP.copyFile(producedIndex, retainedIndex);
  const outputMarker = NodePath.join(navigationDirectory, "main.pdf");
  await NodeFSP.writeFile(outputMarker, new Uint8Array());

  const forward = NodeChildProcess.spawnSync(
    SYNCTEX_RUNTIME,
    ["view", "-i", `3:0:${bodyPath}`, "-o", outputMarker, "-d", navigationDirectory],
    { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000, env: engineEnvironment },
  );
  expect(forward.error).toBeUndefined();
  expect(forward.status, forward.stderr || forward.stdout).toBe(0);
  expect(forward.stdout).toMatch(/SyncTeX result begin/iu);
  const forwardLocation = parseSyncTexForwardLocation(forward.stdout);
  expect(forwardLocation).not.toBeNull();
  if (forwardLocation === null) return null;

  const inverse = NodeChildProcess.spawnSync(
    SYNCTEX_RUNTIME,
    [
      "edit",
      "-o",
      `${forwardLocation.page}:${forwardLocation.x}:${forwardLocation.y}:${outputMarker}`,
      "-d",
      navigationDirectory,
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000, env: engineEnvironment },
  );
  expect(inverse.error).toBeUndefined();
  expect(inverse.status, inverse.stderr || inverse.stdout).toBe(0);
  expect(inverse.stdout).toMatch(/SyncTeX result begin/iu);
  expect(
    parseSyncTexInverseLocations(inverse.stdout).some(
      (location) => /chapters[\\/]body\.tex$/iu.test(location.input) && location.line >= 1,
    ),
  ).toBe(true);
  return { executable, binDirectory, workspace, archivePath, asset: lookup.asset };
}

/**
 * A broken `latexmk` and `pdflatex` first on PATH, the unpacked TinyTeX
 * second: the real probe must pass over the broken pair and name it when
 * nothing else is there, and a compile in the build's environment must reach
 * TinyTeX's `pdflatex`, not the broken one ahead of it on PATH.
 */
const brokenFirstOnPath = (temporaryRoot: string, native: NativeAsset) =>
  Effect.gen(function* () {
    const brokenDirectory = NodePath.join(temporaryRoot, "broken-first");
    const empty = NodePath.join(temporaryRoot, "no-default-installs");
    yield* Effect.promise(() => NodeFSP.mkdir(brokenDirectory, { recursive: true }));
    yield* Effect.promise(() => NodeFSP.mkdir(empty, { recursive: true }));
    const brokenLatexmk = yield* Effect.promise(() =>
      writeBrokenEngine(brokenDirectory, "latexmk"),
    );
    yield* Effect.promise(() => writeBrokenEngine(brokenDirectory, "pdflatex"));
    const systemFolders =
      HOST_PLATFORM === "win32"
        ? [
            NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
            process.env.SystemRoot ?? "C:\\Windows",
          ]
        : ["/usr/bin", "/bin"];

    const onlyBroken = [brokenDirectory];
    const unusable = yield* withProcessPath(
      onlyBroken.join(NodePath.delimiter),
      probeRealToolchain(
        isolatedEnvironment(onlyBroken, empty),
        NodePath.join(temporaryRoot, "state-a"),
      ),
    );
    expect(unusable.kind).toBeNull();
    expect(unusable.unusable?.[0]?.executable.toLowerCase()).toBe(brokenLatexmk.toLowerCase());
    expect(unusable.unusable?.[0]?.reason.length ?? 0).toBeGreaterThan(0);

    const brokenThenTinyTex = [brokenDirectory, native.binDirectory, ...systemFolders];
    const environment = isolatedEnvironment(brokenThenTinyTex, empty);
    const found = yield* withProcessPath(
      brokenThenTinyTex.join(NodePath.delimiter),
      probeRealToolchain(environment, NodePath.join(temporaryRoot, "state-b")),
    );
    expect(found.kind).toBe("latexmk");
    expect(found.source).toBe("system");
    expect(found.executable?.toLowerCase()).toBe(native.executable.toLowerCase());
    expect(found.compilers.find((entry) => entry.compiler === "pdflatex")?.available).toBe(true);

    const fallbackOutput = NodePath.join(temporaryRoot, "fallback-output");
    yield* Effect.promise(() => NodeFSP.mkdir(fallbackOutput, { recursive: true }));
    const compiled = NodeChildProcess.spawnSync(
      found.executable ?? native.executable,
      ["-pdf", "-interaction=nonstopmode", `-outdir=${fallbackOutput}`, "main.tex"],
      {
        cwd: native.workspace,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 2 * 60_000,
        env: {
          ...environment,
          ...latexEngineEnvironment({
            base: {},
            hostEnvironment: environment,
            binDirectory: latexDriverBinDirectory(found, NodePath),
            pathDelimiter: NodePath.delimiter,
          }),
        },
      },
    );
    expect(compiled.error).toBeUndefined();
    expect(compiled.status, compiled.stderr || compiled.stdout).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(fallbackOutput, "main.pdf"))).toBe(true);
  });

/**
 * Windows 10's bsdtar cannot decode this bundle. With the system tar out of
 * reach, the real unpacker must hand the verified download to its own 7-Zip
 * extractor and still leave an engine that starts.
 */
const selfExtractWithoutSystemTar = (temporaryRoot: string, native: NativeAsset) =>
  Effect.gen(function* () {
    const destination = NodePath.join(temporaryRoot, "self-extracted");
    yield* Effect.promise(() => NodeFSP.mkdir(destination, { recursive: true }));
    yield* LatexArchiveUnpacker.use((unpacker) =>
      unpacker.unpack({
        archivePath: native.archivePath,
        destination,
        archive: native.asset.archive,
      }),
    ).pipe(
      Effect.provide(
        Layer.effect(LatexArchiveUnpacker, makeLatexArchiveUnpacker).pipe(
          Layer.provide(ProcessRunner.layer),
          Layer.provide(
            Layer.succeed(HostProcess.Environment, {
              ...process.env,
              SystemRoot: NodePath.join(temporaryRoot, "no-system-tar"),
            }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
    const engine = NodePath.join(destination, native.asset.executableRelativePath);
    expect(NodeFS.existsSync(engine)).toBe(true);
    const environment = isolatedEnvironment(
      [
        NodePath.dirname(engine),
        NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
      ],
      NodePath.join(temporaryRoot, "no-default-installs"),
    );
    const started = NodeChildProcess.spawnSync(engine, ["-v"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      env: environment,
    });
    expect(started.error).toBeUndefined();
    expect(started.status, started.stderr || started.stdout).toBe(0);
  });

/**
 * Unit tests cover failures and state transitions; this opt-in lane proves
 * each native release asset is executable on the operating system it claims
 * to support, and that discovery handles a broken driver ahead of it.
 */
describe.runIf(RUN_ASSET_SMOKE)("pinned TinyTeX native asset", () => {
  it.live(
    `downloads, verifies, unpacks, and starts on ${HOST_PLATFORM}-${HOST_ARCHITECTURE}`,
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-tinytex-asset-smoke-")),
        ),
        (temporaryRoot) =>
          Effect.gen(function* () {
            const native = yield* Effect.promise(() => verifyNativeAsset(temporaryRoot));
            if (native === null) return;
            yield* brokenFirstOnPath(temporaryRoot, native);
            if (HOST_PLATFORM === "win32")
              yield* selfExtractWithoutSystemTar(temporaryRoot, native);
          }),
        (temporaryRoot) =>
          Effect.promise(() => NodeFSP.rm(temporaryRoot, { recursive: true, force: true })),
      ),
    SMOKE_TIMEOUT_MS,
  );
});
