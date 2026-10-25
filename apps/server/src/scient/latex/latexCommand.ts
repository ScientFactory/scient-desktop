/**
 * Run to the end for complete diagnostics with shell escape off and all aux/output outside the
 * workspace. Only LatexBuildService decides publication; a nonzero run's pages cannot replace the
 * last clean PDF.
 */

export type LatexToolchainKind = "latexmk" | "tectonic";
export type LatexEngine = "pdflatex" | "xelatex" | "lualatex";

/**
 * Prepend managed bin only for that subprocess so latexmk finds its own engines/biber. Never modify
 * the user's environment or change system-distribution resolution order.
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
  /** Generated UTF-8 entry point, kept with the compiler's private outputs. */
  readonly inputWrapper?: { readonly path: string; readonly contents: string };
  /** Where the engine leaves the PDF for this invocation. */
  readonly pdfPath: string;
  /** Revision navigation index emitted beside the PDF when the engine supports it. */
  readonly syncTexPath: string;
  /** Engine-produced dependency evidence for the exact run. */
  readonly dependencyManifest: {
    readonly path: string;
    readonly format: "fls" | "makefile";
  };
}

function pdfBaseName(rootRelativePath: string): string {
  const baseName = rootRelativePath.split("/").at(-1) ?? rootRelativePath;
  return baseName.replace(/\.\w+$/u, "");
}

export function buildLatexInvocation(input: {
  readonly toolchain: DiscoveredLatexToolchain;
  readonly engine?: LatexEngine;
  /**
   * Basename of the validated root document. The caller runs the process from
   * that document's directory, so keeping this argument relative avoids
   * TinyTeX's Windows launcher rewriting a long profile path to an 8.3 path
   * containing `~`, which `latexmk` rejects as an unsafe TeX filename.
   */
  readonly rootFileName: string;
  readonly workDirectory: string;
  /** Windows launchers may convert Unicode arguments to the system code page. */
  readonly windows?: boolean;
  /** Same directory relative to the root's cwd, avoiding Unicode profile paths. */
  readonly relativeWorkDirectory?: string;
  /**
   * Force the post-install compile: latexmk's persisted failed/missing-path record does not observe
   * newly installed distribution files. Without -g it can refuse rerun as Nothing to do despite the
   * package now existing.
   */
  readonly forceReprocess?: boolean | undefined;
}): LatexInvocation {
  const wrapRoot =
    input.toolchain.kind === "latexmk" &&
    input.windows === true &&
    /[^ -~]/u.test(input.rootFileName);
  const wrapperName = "scient-unicode-root.tex";
  const outputDirectory = wrapRoot
    ? (input.relativeWorkDirectory ?? input.workDirectory).replaceAll("\\", "/")
    : input.workDirectory;
  const rootFileName = wrapRoot ? `${outputDirectory}/${wrapperName}` : input.rootFileName;
  const jobName = pdfBaseName(rootFileName.replaceAll("\\", "/"));
  const pdfPath = `${input.workDirectory}/${jobName}.pdf`;
  const syncTexPath = `${input.workDirectory}/${jobName}.synctex.gz`;

  if (input.toolchain.kind === "tectonic") {
    // Tectonic keeps no cross-run decision state of its own; every run is a
    // run. Its Make rule output is the run's complete dependency recorder.
    const dependencyPath = `${input.workDirectory}/${jobName}.dependencies.mk`;
    return {
      command: input.toolchain.executable,
      args: [
        "--outdir",
        input.workDirectory,
        "--untrusted",
        "--synctex",
        "--keep-intermediates",
        "--makefile-rules",
        dependencyPath,
        input.rootFileName,
      ],
      pdfPath,
      syncTexPath,
      dependencyManifest: { path: dependencyPath, format: "makefile" },
    };
  }

  return {
    command: input.toolchain.executable,
    ...(wrapRoot
      ? {
          inputWrapper: {
            path: `${input.workDirectory}/${wrapperName}`,
            // TeX reads UTF-8 filenames itself; latexmk only sees the ASCII
            // entry point. Running from the original root directory preserves
            // relative inputs and real source locations in the recorder.
            contents: `\\input{\\detokenize{${input.rootFileName}}}\n`,
          },
        }
      : {}),
    args: [
      ({ pdflatex: "-pdf", xelatex: "-xelatex", lualatex: "-lualatex" } as const)[
        input.engine ?? "pdflatex"
      ],
      "-norc",
      "-interaction=nonstopmode",
      "-file-line-error",
      "-no-shell-escape",
      "-synctex=1",
      ...(input.forceReprocess === true ? ["-g"] : []),
      `-outdir=${outputDirectory}`,
      rootFileName,
    ],
    pdfPath,
    syncTexPath,
    dependencyManifest: {
      path: `${input.workDirectory}/${jobName}.fls`,
      format: "fls",
    },
  };
}
