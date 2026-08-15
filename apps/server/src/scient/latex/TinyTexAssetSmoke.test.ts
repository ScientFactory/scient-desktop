// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- This opt-in test validates native release assets at the reviewed network boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { texliveScriptInvocation } from "./LatexPackageInstaller.ts";
import { resolveTinyTexAsset } from "./tinytexManifest.ts";

const RUN_ASSET_SMOKE = process.env.SCIENT_TINYTEX_ASSET_SMOKE === "1";
const SMOKE_TIMEOUT_MS = 15 * 60 * 1_000;
// oxlint-disable-next-line t3code/no-global-process-runtime -- native runner selection happens at collection time, before an Effect runtime exists.
const HOST_PLATFORM = NodeOS.platform();
// oxlint-disable-next-line t3code/no-global-process-runtime -- native runner selection happens at collection time, before an Effect runtime exists.
const HOST_ARCHITECTURE = NodeOS.arch();

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

        const tlmgr = texliveScriptInvocation({
          binDirectory,
          script: "tlmgr",
          args: ["install", "synctex"],
          platform: HOST_PLATFORM,
          join: (...segments) => NodePath.join(...segments),
          dirname: (segment) => NodePath.dirname(segment),
          pathDelimiter: NodePath.delimiter,
        });
        const installedSyncTex = NodeChildProcess.spawnSync(tlmgr.executable, tlmgr.args, {
          cwd: binDirectory,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          timeout: 5 * 60_000,
          env: {
            ...engineEnvironment,
            ...tlmgr.environment,
            PATH: `${tlmgr.pathPrefix}${NodePath.delimiter}${process.env.PATH ?? ""}`,
          },
        });
        expect(installedSyncTex.error).toBeUndefined();
        expect(installedSyncTex.status, installedSyncTex.stderr || installedSyncTex.stdout).toBe(0);

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
        await NodeFSP.writeFile(
          sourcePath,
          "\\documentclass{article}\n\\begin{document}\nHello Scient.\n\\end{document}\n",
        );
        const compiled = NodeChildProcess.spawnSync(
          executable,
          [
            "-pdf",
            "-synctex=1",
            "-interaction=nonstopmode",
            `-outdir=${outputDirectory}`,
            sourcePath,
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

        const syncTexExecutable = NodePath.join(
          binDirectory,
          HOST_PLATFORM === "win32" ? "synctex.exe" : "synctex",
        );
        const forward = NodeChildProcess.spawnSync(
          syncTexExecutable,
          ["view", "-i", `3:0:${sourcePath}`, "-o", outputMarker, "-d", navigationDirectory],
          { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000, env: engineEnvironment },
        );
        expect(forward.error).toBeUndefined();
        expect(forward.status, forward.stderr || forward.stdout).toBe(0);
        expect(forward.stdout).toMatch(/SyncTeX result begin/iu);
        const page = forward.stdout.match(/^Page:([0-9]+(?:\.[0-9]+)?)$/imu)?.[1];
        const x = forward.stdout.match(/^h:([0-9]+(?:\.[0-9]+)?)$/imu)?.[1];
        const y = forward.stdout.match(/^v:([0-9]+(?:\.[0-9]+)?)$/imu)?.[1];
        expect(page).toBeDefined();
        expect(x).toBeDefined();
        expect(y).toBeDefined();

        const inverse = NodeChildProcess.spawnSync(
          syncTexExecutable,
          ["edit", "-o", `${page}:${x}:${y}:${outputMarker}`, "-d", navigationDirectory],
          { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000, env: engineEnvironment },
        );
        expect(inverse.error).toBeUndefined();
        expect(inverse.status, inverse.stderr || inverse.stdout).toBe(0);
        expect(inverse.stdout).toMatch(/SyncTeX result begin/iu);
        expect(inverse.stdout).toMatch(/^Line:3$/imu);
      } finally {
        await NodeFSP.rm(temporaryRoot, { recursive: true, force: true });
      }
    },
    SMOKE_TIMEOUT_MS,
  );
});
