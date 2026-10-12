import type { EnvironmentId } from "@t3tools/contracts";
import { uploadEnvironmentLatexImage } from "@t3tools/client-runtime/state/scient-latex";
import { runtime } from "~/lib/runtime";
import { readPreparedConnection } from "~/state/session";

export async function uploadLatexImage(
  environmentId: EnvironmentId,
  input: { readonly cwd: string; readonly documentRelativePath: string; readonly file: File },
) {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) throw new Error("The selected environment is not connected.");
  return runtime.runPromise(
    uploadEnvironmentLatexImage({
      prepared,
      cwd: input.cwd,
      documentRelativePath: input.documentRelativePath,
      file: input.file,
      fileName: input.file.name || (input.file.type === "image/jpeg" ? "image.jpeg" : "image.png"),
    }),
  );
}
