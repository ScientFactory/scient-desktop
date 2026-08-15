/**
 * Builds the exact engine invocation for one compile. Every invocation is
 * non-interactive, reports errors in file:line form, keeps shell escape off,
 * emits a SyncTeX index next to the PDF, and writes every aux and output file
 * into a Scient-owned work directory outside the project tree, so builds never
 * dirty the workspace or the agent's checkpoints.
 *
 * Nothing here stops at the first error, and that is about diagnostics rather
 * than about output: `-interaction=nonstopmode` with no `-halt-on-error` runs
 * the engine to the end of the document, so one compile reports every error it
 * can reach instead of only the first. What that run is worth is not decided
 * here — `LatexBuildService` refuses to publish a PDF from a run that exited
 * non-zero, however many pages it managed to typeset, and keeps the last clean
 * PDF visible as stale instead.
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
  /**
   * Run the engine even where the driver believes nothing has changed. Set for
   * the compile that follows a package install: `latexmk` remembers, in the
   * `.fdb_latexmk` it keeps in the work directory, both that the last run
   * failed and which files were missing — recorded at the paths it looked in,
   * one of which is the output directory. Placing `microtype.sty` in the
   * distribution's own tree therefore changes nothing `latexmk` is watching, so
   * on the retry it reports "Nothing to do", refuses to rerun the engine, and
   * exits non-zero with only its own prose. That looks exactly like a document
   * that still cannot find the package it was just given.
   */
  readonly forceReprocess?: boolean | undefined;
}): LatexInvocation {
  const pdfPath = `${input.workDirectory}/${pdfBaseName(
    input.rootAbsolutePath.replaceAll("\\", "/"),
  )}.pdf`;

  if (input.toolchain.kind === "tectonic") {
    // tectonic keeps no cross-run decision state of its own; every run is a run.
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
      ...(input.forceReprocess === true ? ["-g"] : []),
      `-outdir=${input.workDirectory}`,
      input.rootAbsolutePath,
    ],
    pdfPath,
  };
}
