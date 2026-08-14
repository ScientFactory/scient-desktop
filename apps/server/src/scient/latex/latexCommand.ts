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

/**
 * `latexmk` drives `pdflatex`, `biber`, and friends by name, so a distribution
 * that is not on this machine's PATH — the one Scient installs into its own
 * state directory — only works if its `bin` folder leads the child's PATH.
 * This changes one subprocess, never the machine: nothing is written to the
 * user's environment, and a system installation keeps its own resolution
 * order because the managed folder is only prepended for the managed engine.
 */
export function latexEngineEnvironment(input: {
  readonly base: Readonly<Record<string, string>>;
  readonly hostEnvironment: NodeJS.ProcessEnv;
  /** `null` for an engine already on PATH. */
  readonly binDirectory: string | null;
  readonly pathDelimiter: string;
}): Readonly<Record<string, string>> {
  if (input.binDirectory === null) return input.base;
  // Windows spells it `Path`, and passing a second spelling alongside it would
  // leave the child with two, so the existing name is reused.
  const pathKey =
    Object.keys(input.hostEnvironment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const inherited = input.hostEnvironment[pathKey] ?? "";
  return {
    ...input.base,
    [pathKey]:
      inherited === ""
        ? input.binDirectory
        : `${input.binDirectory}${input.pathDelimiter}${inherited}`,
  };
}

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
