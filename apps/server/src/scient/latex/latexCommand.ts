/**
 * Builds the exact engine invocation for one compile. Every invocation is
 * non-interactive, reports errors in file:line form, keeps shell escape off,
 * emits a SyncTeX index next to the PDF, and writes every aux and output file
 * into a Scient-owned work directory outside the project tree, so builds never
 * dirty the workspace or the agent's checkpoints.
 *
 * Nothing here stops at the first error: Overleaf publishes whatever PDF the
 * engine managed to produce and shows the errors beside it, so the engine runs
 * to the end of the document and the caller decides what the exit code means.
 */

export type LatexToolchainKind = "latexmk" | "tectonic";

export interface DiscoveredLatexToolchain {
  readonly kind: LatexToolchainKind;
  readonly executable: string;
  readonly version: string;
}

export interface LatexInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Where the engine leaves the PDF for this invocation. */
  readonly pdfPath: string;
}

function pdfBaseName(rootRelativePath: string): string {
  const baseName = rootRelativePath.split("/").at(-1) ?? rootRelativePath;
  return baseName.replace(/\.\w+$/u, "");
}

export function buildLatexInvocation(input: {
  readonly toolchain: DiscoveredLatexToolchain;
  readonly rootAbsolutePath: string;
  readonly workDirectory: string;
}): LatexInvocation {
  const pdfPath = `${input.workDirectory}/${pdfBaseName(
    input.rootAbsolutePath.replaceAll("\\", "/"),
  )}.pdf`;

  if (input.toolchain.kind === "tectonic") {
    return {
      command: input.toolchain.executable,
      args: ["--outdir", input.workDirectory, "--untrusted", "--synctex", input.rootAbsolutePath],
      pdfPath,
    };
  }

  return {
    command: input.toolchain.executable,
    args: [
      "-pdf",
      "-interaction=nonstopmode",
      "-file-line-error",
      "-no-shell-escape",
      "-synctex=1",
      `-outdir=${input.workDirectory}`,
      input.rootAbsolutePath,
    ],
    pdfPath,
  };
}
