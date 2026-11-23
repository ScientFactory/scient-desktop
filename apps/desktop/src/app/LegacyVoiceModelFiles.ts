// @effect-diagnostics nodeBuiltinImport:off - Dirent checks preserve the distinction between model files and symlinks.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const modelNames = [
  "ggml-small-q5_1-ae85e4a9.bin",
  "ggml-medium-q5_0-19fea4b3.bin",
  "ggml-large-v3-turbo-q5_0-39422170.bin",
];

const legacyFileNames = new Set(
  modelNames.flatMap((name) =>
    ["", ".json", ".partial", ".repair.partial"].map((suffix) => name + suffix),
  ),
);

async function legacyFiles(stateDir: string) {
  const directory = NodePath.join(stateDir, "voice", "models");
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  return entries.flatMap((entry) =>
    entry.isFile() && legacyFileNames.has(entry.name) ? [NodePath.join(directory, entry.name)] : [],
  );
}

export async function hasLegacyVoiceModelFiles(stateDir: string): Promise<boolean> {
  return (await legacyFiles(stateDir)).length > 0;
}

export async function removeLegacyVoiceModelFiles(stateDir: string): Promise<void> {
  const results = await Promise.allSettled(
    (await legacyFiles(stateDir)).map((path) => NodeFSP.rm(path, { force: true })),
  );
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("Some previous dictation model files could not be removed.");
  }
}
