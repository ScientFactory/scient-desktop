// @effect-diagnostics nodeBuiltinImport:off -- Preview runs have private execution identities.
import * as NodeCrypto from "node:crypto";
import { ExecutionRunId } from "@scientfactory/execution";
import type { ScientLatexArtworkRequest, ScientLatexArtworkResult } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../../config.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import { buildLatexInvocation, latexEngineEnvironment } from "./latexCommand.ts";
import { selectLatexBuildEngine } from "./latexEngineGate.ts";
import { parseLatexLog } from "./latexLog.ts";
import { missingLatexPackageInputs } from "./latexMissingPackages.ts";
import { LatexPackageInstaller } from "./LatexPackageInstaller.ts";
import { LatexToolchain } from "./LatexToolchain.ts";

export class LatexTikzPreview extends Context.Service<
  LatexTikzPreview,
  {
    readonly render: (input: ScientLatexArtworkRequest) => Effect.Effect<ScientLatexArtworkResult>;
  }
>()("t3/scient/latex/LatexTikzPreview") {}

const unavailable = (message: string): ScientLatexArtworkResult => ({
  _tag: "unavailable",
  message,
});

/** Compile a picture with its document preamble, without editing or publishing that document. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const workspace = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const paths = yield* WorkspacePaths.WorkspacePaths;
  const processes = yield* LocalExecutionProcess.ExecutionProcess;
  const toolchains = yield* LatexToolchain;
  const packages = yield* LatexPackageInstaller;
  const hostEnvironment = yield* HostProcessEnvironment;
  const delimiter = (yield* HostProcessPlatform) === "win32" ? ";" : ":";
  const gate = yield* Semaphore.make(2);

  const render = Effect.fn("LatexTikzPreview.render")(function* (input: ScientLatexArtworkRequest) {
    const algorithm =
      /^\s*\\begin\{algorithm\}(?:\[[htbpH!]+\])?/u.test(input.source) &&
      /\\end\{algorithm\}\s*$/u.test(input.source) &&
      input.source.includes("\\begin{tikzpicture}");
    if (
      (!algorithm &&
        (!/^\s*\\begin\s*\{tikzpicture\}/u.test(input.source) ||
          !/\\end\s*\{tikzpicture\}\s*$/u.test(input.source))) ||
      /\\(?:begin|end)\s*\{document\}/u.test(input.preamble + input.source)
    )
      return unavailable("The drawing is not a complete TikZ picture.");
    // Use the same project boundary and symlink checks as ordinary file operations.
    const document = yield* workspace.readFile({
      cwd: input.workspaceRoot,
      relativePath: input.relativePath,
    });
    const workspaceRoot = yield* paths.normalizeWorkspaceRoot(input.workspaceRoot);
    const documentDirectory = path.dirname(
      yield* fileSystem.realPath(path.resolve(workspaceRoot, document.relativePath)),
    );
    const toolchain = yield* toolchains.probe(false);
    if (!toolchain.kind || !toolchain.executable)
      return unavailable("Install the LaTeX toolchain to show this drawing.");
    const discovered = {
      kind: toolchain.kind,
      executable: toolchain.executable,
      version: toolchain.version ?? "unknown",
    };
    const compiler = selectLatexBuildEngine({ rootText: input.preamble }, toolchain.kind);
    if (compiler.error) return unavailable(compiler.error);
    const managedBin =
      toolchain.source === "scient-managed" ? path.dirname(toolchain.executable) : null;
    const environment = latexEngineEnvironment({
      base: {
        max_print_line: "1000",
        TEXINPUTS: `${documentDirectory.replaceAll("\\", "/")}/${delimiter}${hostEnvironment.TEXINPUTS ?? ""}${delimiter}`,
      },
      hostEnvironment,
      binDirectory: managedBin,
      pathDelimiter: delimiter,
    });
    const previews = path.join(config.latexDir, "artwork");
    yield* fileSystem.makeDirectory(previews, { recursive: true });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fileSystem.makeTempDirectoryScoped({ directory: previews });
        const sourcePath = path.join(directory, "picture.tex");
        const preamble = /\\documentclass\b/u.test(input.preamble)
          ? input.preamble
          : `\\documentclass{article}\n${input.preamble}`;
        const labels = algorithm
          ? yield* workspace
              .readFile({
                cwd: input.workspaceRoot,
                relativePath: input.relativePath.replace(/\.tex$/iu, ".aux"),
              })
              .pipe(
                Effect.map((file) =>
                  file.truncated
                    ? ""
                    : file.contents
                        .split(/\r?\n/u)
                        .filter((line) => line.startsWith("\\newlabel{"))
                        .join("\n"),
                ),
                Effect.orElseSucceed(() => ""),
              )
          : "";
        const artwork = algorithm
          ? `\\setcounter{algorithm}{${(input.algorithmNumber ?? 1) - 1}}\n` +
            input.source.replace(
              /^\s*\\begin\{algorithm\}(?:\[[htbpH!]+\])?/u,
              "\\begin{algorithm}[H]",
            )
          : input.source;
        yield* fileSystem.writeFileString(
          sourcePath,
          `${preamble}\n\\usepackage[active,tightpage]{preview}\n` +
            `\\setlength{\\PreviewBorder}{0.5pt}\n` +
            `\\makeatletter\n${labels}\n\\makeatother\n` +
            `\\begin{document}\n` +
            `\\setlength{\\textwidth}{${input.widthInches}in}\n\\setlength{\\columnwidth}{${input.widthInches}in}\n` +
            `\\begin{preview}\n\\setlength{\\linewidth}{${input.widthInches}in}\n` +
            `${artwork}\n\\end{preview}\n\\end{document}\n`,
        );
        const invocation = buildLatexInvocation({
          toolchain: discovered,
          engine: compiler.engine,
          rootFileName: "picture.tex",
          workDirectory: directory.replaceAll("\\", "/"),
          forceReprocess: true,
        });
        const attempted = new Set<string>();
        for (let round = 0; round < 10; round++) {
          yield* fileSystem.remove(invocation.pdfPath, { force: true });
          const outcome = yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* Effect.acquireRelease(
                processes.start({
                  runId: ExecutionRunId.make(NodeCrypto.randomUUID()),
                  executable: invocation.command,
                  args: invocation.args,
                  cwd: directory,
                  environment,
                }),
                (handle) => handle.cancel.pipe(Effect.ignoreCause()),
              );
              const transcript = yield* Ref.make("");
              const output = yield* handle.output.pipe(
                Stream.runForEach((chunk) =>
                  Ref.update(transcript, (text) => (text + chunk.text).slice(-256_000)),
                ),
                Effect.forkScoped,
              );
              const exit = yield* handle.exitCode.pipe(Effect.timeoutOption("60 seconds"));
              if (Option.isNone(exit)) yield* handle.cancel.pipe(Effect.ignoreCause());
              yield* Fiber.join(output).pipe(Effect.ignoreCause());
              return { exit: Option.getOrNull(exit), transcript: yield* Ref.get(transcript) };
            }),
          );
          if (outcome.exit === null) return unavailable("The drawing preview timed out.");
          if (outcome.exit === 0) {
            const info = yield* fileSystem.stat(invocation.pdfPath);
            if (info.size > 6_000_000n) return unavailable("The drawing preview is too large.");
            const pdf = yield* fileSystem.readFile(invocation.pdfPath);
            return { _tag: "ready" as const, pdfBase64: Buffer.from(pdf).toString("base64") };
          }
          const missing = missingLatexPackageInputs(outcome.transcript).filter(
            (item) => !attempted.has(item.packageName),
          );
          if (managedBin && missing.length && round < 9) {
            for (const item of missing) attempted.add(item.packageName);
            const installed = yield* packages.install({
              binDirectory: managedBin,
              packages: missing.map((item) => item.packageName),
              expectedFiles: missing.map((item) => item.fileName),
              timeout: "60 seconds",
            });
            if (installed.installed.length) continue;
          }
          return unavailable(
            parseLatexLog(outcome.transcript).find((item) => item.severity === "error")?.message ??
              "The LaTeX toolchain could not render this drawing.",
          );
        }
        return unavailable("The drawing's packages could not be resolved.");
      }),
    );
  });
  return LatexTikzPreview.of({
    render: (input) =>
      gate
        .withPermits(1)(render(input))
        .pipe(
          Effect.timeout("150 seconds"),
          Effect.catch((error) =>
            Effect.logDebug("TikZ preview unavailable", { error }).pipe(
              Effect.as(unavailable("The drawing preview is unavailable. Check the LaTeX build.")),
            ),
          ),
        ),
  });
});

export const layer = Layer.effect(LatexTikzPreview, make);
