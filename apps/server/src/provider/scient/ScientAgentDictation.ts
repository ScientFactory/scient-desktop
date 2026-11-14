/**
 * Dictation with ChatGPT through Scient Agent: the agent holds the ChatGPT sign-in, so Scient
 * writes the recording to a private folder and runs `scient-agent dictate <file> --json`, which
 * uploads it to ChatGPT's own transcription service and prints the text.
 */
import { ChatGptDictationError, type ChatGptDictationErrorReason } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { canonicalOmpExecutablePath, OmpExecutableGate } from "../omp/OmpExecutableGate.ts";
import type { ProviderVoiceDictation } from "../ScientProviderInstanceSeams.ts";
import { scientAgentTarget } from "./ScientAgentTarget.ts";

/** The first Scient Agent release with `dictate`. An older one would read the word as a prompt. */
const SCIENT_AGENT_DICTATION_VERSION = "0.1.9";
const OUTPUT_LIMIT = 1024 * 1024;

const DictateOutput = Schema.Union([
  Schema.Struct({ text: Schema.String }),
  Schema.Struct({ error: Schema.Struct({ kind: Schema.String }) }),
]);
const decodeDictateOutput = Schema.decodeUnknownOption(Schema.fromJsonString(DictateOutput));

const AGENT_REASONS: ReadonlySet<string> = new Set<ChatGptDictationErrorReason>([
  "signed-out",
  "invalid-audio",
  "rate-limited",
  "unavailable",
]);

const fail = (reason: ChatGptDictationErrorReason) => new ChatGptDictationError({ reason });
const isDictationError = Schema.is(ChatGptDictationError);

/** The text, or the reason the agent gave, from what `dictate --json` printed. */
function readDictateOutput(stdout: string): string | ChatGptDictationError {
  const lastLine = stdout.trim().split("\n").at(-1) ?? "";
  const decoded = decodeDictateOutput(lastLine);
  if (decoded._tag === "None") return fail("agent-unavailable");
  if ("text" in decoded.value) return decoded.value.text.trim();
  const kind = decoded.value.error.kind;
  return fail(AGENT_REASONS.has(kind) ? (kind as ChatGptDictationErrorReason) : "unavailable");
}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Uint8Array[], bytes: 0 }),
      (state, chunk) => {
        if (state.bytes + chunk.length > OUTPUT_LIMIT)
          return Effect.fail(fail("agent-unavailable"));
        state.chunks.push(chunk);
        state.bytes += chunk.length;
        return Effect.succeed(state);
      },
    ),
    Effect.map((state) => Buffer.concat(state.chunks).toString("utf8")),
  );

export interface ScientAgentDictationOptions {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  /** Where the agent runs, and where each recording's private folder is made. */
  readonly workDir: string;
}

export const makeScientAgentDictation = Effect.fn("makeScientAgentDictation")(function* (
  options: ScientAgentDictationOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gate = yield* OmpExecutableGate;
  const env = options.environment;

  const run = Effect.fn("ScientAgentDictation.run")(function* (
    executable: string,
    args: ReadonlyArray<string>,
  ) {
    const command = yield* resolveSpawnCommand(executable, args, { env, extendEnv: false });
    const child = yield* spawner.spawn(
      ChildProcess.make(command.command, command.args, {
        env,
        extendEnv: false,
        cwd: options.workDir,
        shell: command.shell,
        stdin: "ignore",
        forceKillAfter: "1 second",
      }),
    );
    const [stdout] = yield* Effect.all(
      [collect(child.stdout), collect(child.stderr), child.exitCode],
      { concurrency: "unbounded" },
    );
    return stdout;
  });

  const dictate: ProviderVoiceDictation["dictate"] = Effect.fn("ScientAgentDictation.dictate")(
    function* (input) {
      const resolved =
        (yield* resolveCommandPath(options.binaryPath, { env, bypassCache: true })) ??
        options.binaryPath;
      // An update in progress holds the executable; dictation waits its turn like any process.
      yield* gate.acquireProcess(yield* canonicalOmpExecutablePath(resolved), {
        target: scientAgentTarget,
        kind: "one-shot",
      });
      const runtime = scientAgentTarget.identify(yield* run(resolved, ["--runtime-info"]));
      if (!runtime) return yield* fail("agent-unavailable");
      if (compareSemverVersions(runtime.version, SCIENT_AGENT_DICTATION_VERSION) < 0)
        return yield* fail("update-required");
      // The recording lives only as long as this request, in a folder only this user can read.
      const folder = yield* fs.makeTempDirectoryScoped({
        directory: options.workDir,
        prefix: "dictation-",
      });
      const file = path.join(folder, "dictation.wav");
      yield* fs.writeFile(file, input.wav, { mode: 0o600 });
      const output = yield* run(resolved, [
        "dictate",
        file,
        "--json",
        ...(input.language ? ["--language", input.language] : []),
      ]);
      const result = readDictateOutput(output);
      return typeof result === "string" ? { text: result } : yield* result;
    },
    Effect.scoped,
    // ChatGPT answers a long dictation in seconds; a stuck upload must not hold the composer.
    Effect.timeoutOrElse({
      duration: "90 seconds",
      orElse: () => Effect.fail(fail("unavailable")),
    }),
    Effect.mapError((error) => (isDictationError(error) ? error : fail("agent-unavailable"))),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );

  return { dictate } satisfies ProviderVoiceDictation;
});
