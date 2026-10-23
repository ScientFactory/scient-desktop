import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { JsignConfigurationError, JsignFailedError, signWithJsign } from "./windows-jsign.ts";

it.effect.each([
  { exitCode: 0, endpoint: "https://eus.codesigning.azure.net/", valid: true },
  { exitCode: 7, endpoint: "https://eus.codesigning.azure.net/", valid: true },
  { exitCode: 0, endpoint: "not a URL", valid: false },
  { exitCode: 0, endpoint: "http://eus.codesigning.azure.net/", valid: false },
  { exitCode: 0, endpoint: "https://user:password@eus.codesigning.azure.net/", valid: false },
])(
  "signs with the configured executable and reports failures: %j",
  ({ exitCode, endpoint, valid }) => {
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const spawner = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const { command: executable, args } = command as unknown as (typeof commands)[number];
        commands.push({ command: executable, args });
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      }),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const file = "/stage/Scient desktop.exe";
        if (!valid) {
          const error = yield* signWithJsign(file).pipe(Effect.flip);
          assert.instanceOf(error, JsignConfigurationError);
          assert.lengthOf(commands, 0);
          return;
        }
        if (exitCode === 0) yield* signWithJsign(file);
        else {
          const error = yield* signWithJsign(file).pipe(Effect.flip);
          assert.instanceOf(error, JsignFailedError);
          assert.equal(error.exitCode, exitCode);
          assert.equal(error.file, file);
        }
        assert.deepStrictEqual(commands, [
          {
            command: "/pinned tools/jsign",
            args: [
              "--storetype",
              "TRUSTEDSIGNING",
              "--keystore",
              "eus.codesigning.azure.net",
              "--alias",
              "account/profile",
              "--alg",
              "SHA-256",
              "--tsaurl",
              "http://timestamp.acs.microsoft.com",
              "--tsmode",
              "RFC3161",
              "--replace",
              file,
            ],
          },
        ]);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawner,
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_JSIGN: "/pinned tools/jsign",
                AZURE_TRUSTED_SIGNING_ENDPOINT: endpoint,
                AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "account",
                AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: "profile",
              },
            }),
          ),
        ),
      ),
    );
  },
);
