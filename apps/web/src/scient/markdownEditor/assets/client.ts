import { uploadEnvironmentMarkdownImage } from "@t3tools/client-runtime/state/scient-markdown";
import type { EnvironmentId, ScientMarkdownImageUploadResult } from "@t3tools/contracts";

import { runtime } from "~/lib/runtime";
import { readPreparedConnection } from "~/state/session";

export async function uploadMarkdownImage(
  environmentId: EnvironmentId,
  input: {
    readonly cwd: string;
    readonly documentRelativePath: string;
    readonly file: File;
    readonly assetDirectory?: string | undefined;
  },
): Promise<ScientMarkdownImageUploadResult> {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) throw new Error("The selected environment is not connected.");
  return runtime.runPromise(
    uploadEnvironmentMarkdownImage({
      prepared,
      cwd: input.cwd,
      documentRelativePath: input.documentRelativePath,
      file: input.file,
      fileName: input.file.name,
      ...(input.assetDirectory ? { assetDirectory: input.assetDirectory } : {}),
    }),
  );
}
