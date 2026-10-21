// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- This opt-in test validates native release assets at the reviewed network boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { latexEngineEnvironment } from "./latexCommand.ts";
import {
  LatexToolchain,
  latexDriverBinDirectory,
  make as makeLatexToolchain,
  type LatexToolchainProbe,
} from "./LatexToolchain.ts";
import { resolveTinyTexAsset } from "./tinytexManifest.ts";
import { parseSyncTexForwardLocation, parseSyncTexInverseLocations } from "./syncTexOutput.ts";

const RUN_ASSET_SMOKE = process.env.SCIENT_TINYTEX_ASSET_SMOKE === "1";
const SYNCTEX_RUNTIME = process.env.SCIENT_SYNCTEX_RUNTIME;
const SMOKE_TIMEOUT_MS = 15 * 60 * 1_000;
// oxlint-disable-next-line t3code/no-global-process-runtime -- native runner selection happens at collection time, before an Effect runtime exists.
const HOST_PLATFORM = NodeOS.platform();
// oxlint-disable-next-line t3code/no-global-process-runtime -- native runner selection happens at collection time, before an Effect runtime exists.
const HOST_ARCHITECTURE = NodeOS.arch();

/**
 * Runs the real toolchain probe against whatever PATH this process has, with
 * an empty state directory so no managed install can answer instead.
 */
async function probeRealToolchain(stateDirectory: string): Promise<LatexToolchainProbe> {
  const layer = Layer.effect(LatexToolchain, makeLatexToolchain).pipe(
    Layer.provide(ProcessRunner.layer),
    Layer.provide(ServerConfig.layerTest(stateDirectory, stateDirectory)),
    Layer.provide(NodeServices.layer),
  );
  return Effect.runPromise(
    LatexToolchain.use((toolchain) => toolchain.probe(true)).pipe(Effect.provide(layer)),
  );
}

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
 * app uses, and starts its real `latexmk`. Unit tests cover failures and state
 * transitions; this opt-in lane proves each native release asset is executable
 * on the operating system it claims to support.
 */
describe.runIf(RUN_ASSET_SMOKE)("pinned TinyTeX native asset", () => {
  it(
    `downloads, verifies, unpacks, and starts on ${HOST_PLATFORM}-${HOST_ARCHITECTURE}`,
    async () => {
      const lookup = resolveTinyTexAsset(HOST_PLATFORM, HOST_ARCHITECTURE);
      expect(lookup.supported, `No asset is pinned for ${HOST_PLATFORM}-${HOST_ARCHITECTURE}`).toBe(
        true,
      );
      if (!lookup.supported) return;
      expect(SYNCTEX_RUNTIME, "SCIENT_SYNCTEX_RUNTIME must name the bundled helper").toBeTruthy();
      if (!SYNCTEX_RUNTIME) return;
      expect(NodeFS.existsSync(SYNCTEX_RUNTIME)).toBe(true);

      const temporaryRoot = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "scient-tinytex-asset-smoke-"),
      );
      const archivePath = NodePath.join(temporaryRoot, lookup.asset.fileName);
      const payloadPath = NodePath.join(temporaryRoot, "payload");
      try {
        const response = await fetch(lookup.asset.url);
        expect(response.ok).toBe(true);
        expect(response.body).not.toBeNull();
        if (response.body === null) return;

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
        if (forwardLocation === null) return;

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

        // A broken latexmk and pdflatex first on PATH, the unpacked TinyTeX
        // second: the probe must pass over the broken pair, and a compile with
        // the build's environment must reach TinyTeX's pdflatex, not the
        // broken one that comes first on the inherited PATH.
        const brokenDirectory = NodePath.join(temporaryRoot, "broken-first");
        await NodeFSP.mkdir(brokenDirectory, { recursive: true });
        const brokenLatexmk = await writeBrokenEngine(brokenDirectory, "latexmk");
        await writeBrokenEngine(brokenDirectory, "pdflatex");
        const inheritedPath = process.env.PATH;
        try {
          process.env.PATH = [brokenDirectory, inheritedPath ?? ""].join(NodePath.delimiter);
          const unusable = await probeRealToolchain(NodePath.join(temporaryRoot, "state-a"));
          expect(unusable.kind).toBeNull();
          expect(unusable.unusable?.[0]?.executable.toLowerCase()).toBe(
            brokenLatexmk.toLowerCase(),
          );
          expect(unusable.unusable?.[0]?.reason.length ?? 0).toBeGreaterThan(0);

          process.env.PATH = [brokenDirectory, binDirectory, inheritedPath ?? ""].join(
            NodePath.delimiter,
          );
          const found = await probeRealToolchain(NodePath.join(temporaryRoot, "state-b"));
          expect(found.kind).toBe("latexmk");
          expect(found.source).toBe("system");
          expect(found.executable?.toLowerCase()).toBe(executable.toLowerCase());
          expect(found.compilers.find((entry) => entry.compiler === "pdflatex")?.available).toBe(
            true,
          );

          const fallbackOutput = NodePath.join(temporaryRoot, "fallback-output");
          await NodeFSP.mkdir(fallbackOutput, { recursive: true });
          const fallbackCompile = NodeChildProcess.spawnSync(
            found.executable ?? executable,
            ["-pdf", "-interaction=nonstopmode", `-outdir=${fallbackOutput}`, "main.tex"],
            {
              cwd: workspace,
              encoding: "utf8",
              maxBuffer: 4 * 1024 * 1024,
              timeout: 2 * 60_000,
              env: {
                ...process.env,
                ...latexEngineEnvironment({
                  base: {},
                  hostEnvironment: process.env,
                  binDirectory: latexDriverBinDirectory(found, NodePath),
                  pathDelimiter: NodePath.delimiter,
                }),
              },
            },
          );
          expect(fallbackCompile.error).toBeUndefined();
          expect(fallbackCompile.status, fallbackCompile.stderr || fallbackCompile.stdout).toBe(0);
          expect(NodeFS.existsSync(NodePath.join(fallbackOutput, "main.pdf"))).toBe(true);
        } finally {
          if (inheritedPath === undefined) delete process.env.PATH;
          else process.env.PATH = inheritedPath;
        }
      } finally {
        await NodeFSP.rm(temporaryRoot, { recursive: true, force: true });
      }
    },
    SMOKE_TIMEOUT_MS,
  );
});
