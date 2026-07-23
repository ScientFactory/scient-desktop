import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { resolveDesktopCodexVoiceProcessContext } from "./desktopCodexVoiceRuntime";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => FS.rm(directory, { recursive: true, force: true })),
  );
});

async function makeRuntimeRoot(): Promise<{ root: string; stateDirectory: string }> {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "scient-voice-runtime-"));
  temporaryDirectories.push(root);
  const stateDirectory = Path.join(root, "userdata");
  await FS.mkdir(stateDirectory, { recursive: true });
  return { root, stateDirectory };
}

describe("resolveDesktopCodexVoiceProcessContext", () => {
  it("uses configured Codex binary and the prepared auth overlay", async () => {
    const { root, stateDirectory } = await makeRuntimeRoot();
    const overlay = Path.join(root, "codex-home-overlay");
    await FS.mkdir(overlay, { recursive: true });
    await FS.writeFile(Path.join(overlay, "auth.json"), "{}", "utf8");
    await FS.writeFile(
      Path.join(stateDirectory, "settings.json"),
      JSON.stringify({
        providers: { codex: { binaryPath: "/opt/scient/codex", homePath: "/source/codex" } },
      }),
      "utf8",
    );

    await expect(
      resolveDesktopCodexVoiceProcessContext({
        stateDirectory,
        scientHome: root,
        env: { PATH: "" },
      }),
    ).resolves.toMatchObject({
      binaryPath: "/opt/scient/codex",
      env: { CODEX_HOME: overlay, SCIENT_HOME: root },
    });
  });

  it("uses the active managed Codex runtime when no system binary is available", async () => {
    const { root, stateDirectory } = await makeRuntimeRoot();
    const managedRoot = Path.join(stateDirectory, "provider-runtimes", "codex");
    const executablePath = Path.join(managedRoot, "releases", "v1", "bin", "codex");
    const executableContents = "runtime";
    await FS.mkdir(Path.dirname(executablePath), { recursive: true });
    await FS.writeFile(executablePath, executableContents, "utf8");
    await FS.writeFile(
      Path.join(managedRoot, "current.json"),
      JSON.stringify({
        version: 1,
        provider: "codex",
        releaseId: "v1",
        executableRelativePath: Path.join("bin", "codex"),
        executablePath,
        executableDigest: createHash("sha256").update(executableContents).digest("hex"),
      }),
      "utf8",
    );

    await expect(
      resolveDesktopCodexVoiceProcessContext({
        stateDirectory,
        scientHome: root,
        env: { PATH: "", CODEX_HOME: "/source/codex" },
      }),
    ).resolves.toMatchObject({
      binaryPath: executablePath,
      env: { CODEX_HOME: "/source/codex" },
    });
  });

  it("fails closed when a managed Codex executable no longer matches its digest", async () => {
    const { root, stateDirectory } = await makeRuntimeRoot();
    const managedRoot = Path.join(stateDirectory, "provider-runtimes", "codex");
    const executablePath = Path.join(managedRoot, "releases", "v1", "bin", "codex");
    await FS.mkdir(Path.dirname(executablePath), { recursive: true });
    await FS.writeFile(executablePath, "tampered", "utf8");
    await FS.writeFile(
      Path.join(managedRoot, "current.json"),
      JSON.stringify({
        version: 1,
        provider: "codex",
        releaseId: "v1",
        executableRelativePath: Path.join("bin", "codex"),
        executablePath,
        executableDigest: createHash("sha256").update("original").digest("hex"),
      }),
      "utf8",
    );

    await expect(
      resolveDesktopCodexVoiceProcessContext({
        stateDirectory,
        scientHome: root,
        env: { PATH: "" },
      }),
    ).rejects.toThrow(/refused an unverified managed Codex runtime/i);
  });

  it("rejects remote voice when Codex is disabled", async () => {
    const { root, stateDirectory } = await makeRuntimeRoot();
    await FS.writeFile(
      Path.join(stateDirectory, "settings.json"),
      JSON.stringify({ providers: { codex: { enabled: false } } }),
      "utf8",
    );

    await expect(
      resolveDesktopCodexVoiceProcessContext({ stateDirectory, scientHome: root, env: {} }),
    ).rejects.toThrow(/disabled/i);
  });
});
