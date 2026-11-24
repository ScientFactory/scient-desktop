// @effect-diagnostics nodeBuiltinImport:off - Dirent checks preserve the distinction between model files and symlinks.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { hasLegacyVoiceModelFiles, removeLegacyVoiceModelFiles } from "./LegacyVoiceModelFiles.ts";

it("reports and removes only installed legacy files from the selected profile", async () => {
  const profile = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-old-models-"));
  try {
    expect(await hasLegacyVoiceModelFiles(profile)).toBe(false);
    const directory = NodePath.join(profile, "voice", "models");
    await NodeFSP.mkdir(directory, { recursive: true });
    const legacy = "ggml-small-q5_1-ae85e4a9.bin";
    const retained = "model.gguf";
    for (const name of [`${legacy}.partial`, `${legacy}.repair.partial`, retained]) {
      await NodeFSP.writeFile(NodePath.join(directory, name), name);
    }
    await NodeFSP.mkdir(NodePath.join(directory, legacy));
    await NodeFSP.symlink(retained, NodePath.join(directory, `${legacy}.json`), "file");
    expect(await hasLegacyVoiceModelFiles(profile)).toBe(true);
    expect(await NodeFSP.readdir(directory)).toHaveLength(5);

    await removeLegacyVoiceModelFiles(profile);
    await removeLegacyVoiceModelFiles(profile);
    expect(await hasLegacyVoiceModelFiles(profile)).toBe(false);
    expect((await NodeFSP.readdir(directory)).sort()).toEqual(
      [legacy, `${legacy}.json`, retained].sort(),
    );
  } finally {
    await NodeFSP.rm(profile, { recursive: true, force: true });
  }
});
