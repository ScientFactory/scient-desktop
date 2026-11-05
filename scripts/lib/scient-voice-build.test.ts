// @effect-diagnostics nodeBuiltinImport:off -- staged runtime files on disk, as packaging reads them.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  WHISPER_CPP_COMMIT,
  WHISPER_CPP_VERSION,
  isStagedWhisperRuntime,
} from "../stage-whisper-runtime.ts";
import { stageScientVoiceRuntimeForDesktopBuild } from "./scient-voice-build.ts";

const temporary: string[] = [];
afterEach(() =>
  Promise.all(temporary.splice(0).map((path) => NodeFSP.rm(path, { recursive: true }))),
);
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

/** A runtime as stage-whisper-runtime.ts writes it, with a stand-in for the helper. */
async function stagedRuntime(directory: string) {
  await NodeFSP.mkdir(directory, { recursive: true });
  const files = { "LICENSE.whisper.cpp": "license", "whisper-server": "helper" };
  for (const [file, contents] of Object.entries(files))
    await NodeFSP.writeFile(NodePath.join(directory, file), contents);
  await NodeFSP.writeFile(
    NodePath.join(directory, "provenance.json"),
    JSON.stringify({
      component: "whisper.cpp",
      version: WHISPER_CPP_VERSION,
      platform: "mac",
      arch: "arm64",
      source: { commit: WHISPER_CPP_COMMIT },
      files: Object.entries(files).map(([file, contents]) => ({
        file,
        sha256: sha256(contents),
        size: contents.length,
      })),
    }),
  );
}

describe("scient voice build adapter", () => {
  it("stages a runtime built earlier only when its receipt verifies", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-voice-build-"));
    temporary.push(root);
    const source = NodePath.join(root, "source");
    const resources = NodePath.join(root, "resources");
    await stagedRuntime(source);
    const stage = () =>
      stageScientVoiceRuntimeForDesktopBuild({
        repoRoot: root,
        stageResourcesDir: resources,
        platform: "mac",
        arch: "arm64",
        sourceDirectory: source,
        verbose: false,
      });

    await stage();
    expect(
      await isStagedWhisperRuntime(NodePath.join(resources, "whisper-runtime"), "mac", "arm64"),
    ).toBe(true);

    await NodeFSP.writeFile(NodePath.join(source, "whisper-server"), "changed");
    await expect(stage()).rejects.toThrow("is not the verified whisper.cpp runtime");
  });
});
