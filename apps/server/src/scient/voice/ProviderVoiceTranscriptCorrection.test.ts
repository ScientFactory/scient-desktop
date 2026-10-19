// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { expect } from "vite-plus/test";

import { makeAntigravityVoiceTranscriptCorrection } from "./AntigravityVoiceTranscriptCorrection.ts";
import { makeClaudeVoiceTranscriptCorrection } from "./ClaudeVoiceTranscriptCorrection.ts";
import { makeCodexVoiceTranscriptCorrection } from "./CodexVoiceTranscriptCorrection.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const agyMockPath = NodePath.join(__dirname, "../../../scripts/agy-stream-mock.ts");

function makeExecutable(name: string, source: string) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-voice-provider-"));
  const binaryPath = NodePath.join(directory, name);
  NodeFS.writeFileSync(binaryPath, source, "utf8");
  NodeFS.chmodSync(binaryPath, 0o755);
  return { directory, binaryPath };
}

function removeExecutable(directory: string) {
  return Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
}

it.layer(NodeServices.layer)("provider voice transcript correction", (it) => {
  it.effect.each([
    { model: "custom-claude-model", effort: undefined },
    { model: "claude-sonnet-4-6", effort: "low" },
  ])("selects Claude effort from advertised capabilities for $model", ({ model, effort }) =>
    Effect.gen(function* () {
      let spawnedArgs: ReadonlyArray<string> | undefined;
      const spawner = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) return Effect.die("Expected one command.");
        spawnedArgs = command.args;
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(
              Stream.make('{"structured_output":{"text":"Hello, Claude."}}'),
            ),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      });
      const service = yield* makeClaudeVoiceTranscriptCorrection(
        decodeClaudeSettings({ binaryPath: process.execPath }),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const result = yield* service.correct({
        transcript: "helo claude",
        modelSelection: createModelSelection(ProviderInstanceId.make("claudeAgent"), model),
      });
      expect(result).toEqual({ text: "Hello, Claude." });
      expect(spawnedArgs).toBeDefined();
      expect(
        spawnedArgs?.slice(spawnedArgs.indexOf("--model"), spawnedArgs.indexOf("--model") + 2),
      ).toEqual(["--model", model]);
      if (effort === undefined) {
        expect(spawnedArgs).not.toContain("--effort");
      } else {
        expect(
          spawnedArgs?.slice(spawnedArgs.indexOf("--effort"), spawnedArgs.indexOf("--effort") + 2),
        ).toEqual(["--effort", effort]);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("runs Codex through its isolated structured-output path", () =>
    Effect.gen(function* () {
      const mock = makeExecutable(
        "codex",
        [
          "#!/bin/sh",
          'case " $* " in',
          '  *" --strict-config "*) ;;',
          "  *) exit 8 ;;",
          "esac",
          'case " $* " in',
          '  *" --listen "*) exit 9 ;;',
          "esac",
          'output_path=""',
          "while [ $# -gt 0 ]; do",
          '  if [ "$1" = "--output-last-message" ]; then',
          "    shift",
          '    output_path="$1"',
          "  fi",
          "  shift",
          "done",
          "cat >/dev/null",
          'printf "%s" "$SCIENT_VOICE_TEST_OUTPUT" > "$output_path"',
          "",
        ].join("\n"),
      );
      yield* Effect.addFinalizer(() => removeExecutable(mock.directory));
      const service = yield* makeCodexVoiceTranscriptCorrection(
        decodeCodexSettings({
          binaryPath: mock.binaryPath,
          launchArgs: "--strict-config --listen 9999",
        }),
        { ...process.env, SCIENT_VOICE_TEST_OUTPUT: '{"text":"Hello, world."}' },
      );

      const result = yield* service.correct({
        transcript: "helo world",
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6"),
      });

      expect(result).toEqual({ text: "Hello, world." });
    }).pipe(Effect.scoped),
  );

  it.effect("runs Claude without forcing effort on an unknown custom model", () =>
    Effect.gen(function* () {
      const mock = makeExecutable(
        "claude",
        [
          "#!/bin/sh",
          'case " $* " in',
          '  *" --effort "*) exit 9 ;;',
          "esac",
          "cat >/dev/null",
          'printf "%s" "$SCIENT_VOICE_TEST_OUTPUT"',
          "",
        ].join("\n"),
      );
      yield* Effect.addFinalizer(() => removeExecutable(mock.directory));
      const service = yield* makeClaudeVoiceTranscriptCorrection(
        decodeClaudeSettings({ binaryPath: mock.binaryPath }),
        {
          ...process.env,
          SCIENT_VOICE_TEST_OUTPUT: '{"structured_output":{"text":"Hello, Claude."}}',
        },
      );

      const result = yield* service.correct({
        transcript: "helo claude",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "custom-claude-model",
        ),
      });

      expect(result).toEqual({ text: "Hello, Claude." });
    }).pipe(Effect.scoped),
  );

  it.effect("runs Antigravity through its sandboxed stream protocol", () =>
    Effect.gen(function* () {
      const mock = makeExecutable(
        "agy",
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(agyMockPath)} "$@"\n`,
      );
      yield* Effect.addFinalizer(() => removeExecutable(mock.directory));
      const service = yield* makeAntigravityVoiceTranscriptCorrection(
        decodeAntigravitySettings({ binaryPath: mock.binaryPath }),
        {
          ...process.env,
          AGY_MOCK_STRUCTURED_OUTPUT: encodeUnknownJson({ text: "Hello, Antigravity." }),
        },
      );

      const result = yield* service.correct({
        transcript: "helo antigravity",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("antigravity"),
          "gemini-3.7-flash",
        ),
      });

      expect(result).toEqual({ text: "Hello, Antigravity." });

      const toolAttempt = yield* service
        .correct({
          transcript: "TOOL",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("antigravity"),
            "gemini-3.7-flash",
          ),
        })
        .pipe(Effect.result);
      expect(Result.isFailure(toolAttempt)).toBe(true);
      if (Result.isFailure(toolAttempt)) expect(toolAttempt.failure.kind).toBe("provider-error");
    }).pipe(Effect.scoped),
  );
});
