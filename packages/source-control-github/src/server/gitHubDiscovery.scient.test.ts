import { ServerSettings, VcsProcessTimeoutError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

const timeout = (input: SourceControlHost.SourceControlProcessInput) =>
  Effect.fail(
    new VcsProcessTimeoutError({
      operation: input.operation,
      command: input.command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? 5_000,
    }),
  );

/** GitHub discovery with the app signed in as "Octo" and gh answering through `run`. */
const appSignedInDiscovery = (
  run: SourceControlHost.SourceControlHost["Service"]["process"]["run"],
) =>
  Effect.gen(function* () {
    const appSettings = decodeSettings({
      sourceControlHosts: {
        github: { signIns: { "github.com": "app-token" } },
      },
    });
    const hostLayer = Layer.effect(
      SourceControlHost.SourceControlHost,
      Effect.gen(function* () {
        const host = yield* SourceControlHost.SourceControlHost;
        return {
          ...host,
          settings: {
            ...host.settings,
            getWithSecrets: () => Effect.succeed(appSettings),
          },
        };
      }),
    ).pipe(Layer.provide(TestSourceControlHost.layer({ settings: appSettings, process: { run } })));

    const discovery = yield* GitHubSourceControlProvider.makeDiscovery.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(GitHubRest.GitHubRest)({
            rest: () =>
              Effect.succeed({
                status: 200,
                headers: {},
                body: JSON.stringify({ login: "Octo" }),
                truncated: false,
                invalidUtf8: false,
              }),
          }),
          Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({ enabled: true }),
          FileSystem.layerNoop({}),
          hostLayer,
        ),
      ),
      Effect.provideService(HostProcess.Environment, {}),
    );
    if (discovery.type !== "managed-cli")
      return yield* Effect.die("expected managed-cli discovery");
    return discovery;
  });

it.effect(
  "preserves cliAuthStatus='unknown' when app sign-in succeeds during a gh auth status failure and clears it on recovery",
  () =>
    Effect.gen(function* () {
      let authStatusCalls = 0;
      const discovery = yield* appSignedInDiscovery((input) => {
        if (input.args.includes("--version")) {
          return Effect.succeed(TestSourceControlHost.processOutput("gh version 2.86.0\n"));
        }
        authStatusCalls += 1;
        if (authStatusCalls === 1) return timeout(input);
        return Effect.succeed(
          TestSourceControlHost.processOutput(
            JSON.stringify({
              hosts: {
                "github.com": [
                  { host: "github.com", login: "octo", active: true, state: "success" },
                  { host: "github.com", login: "second", active: false, state: "success" },
                ],
              },
            }),
          ),
        );
      });

      const first = yield* discovery.probe("/repo");
      assert.strictEqual(first.status, "available");
      assert.strictEqual(first.auth.status, "authenticated");
      assert.deepStrictEqual(first.auth.account, Option.some("Octo"));
      assert.strictEqual(first.auth.cliAuthStatus, "unknown");
      assert.isUndefined(first.auth.accounts);

      const second = yield* discovery.probe("/repo");
      assert.strictEqual(second.status, "available");
      assert.strictEqual(second.auth.status, "authenticated");
      assert.deepStrictEqual(second.auth.account, Option.some("Octo"));
      assert.isUndefined(second.auth.cliAuthStatus);
      assert.deepStrictEqual(
        second.auth.accounts?.map((entry) => entry.account),
        ["octo", "second"],
      );
    }).pipe(Effect.provideService(SpawnExecutableResolution, (command) => `/usr/bin/${command}`)),
);

it.effect("keeps cliAuthStatus='unknown' when an installed gh times out its version probe", () =>
  Effect.gen(function* () {
    const discovery = yield* appSignedInDiscovery(timeout);
    const result = yield* discovery.probe("/repo");
    assert.strictEqual(result.auth.status, "authenticated");
    assert.strictEqual(result.auth.cliAuthStatus, "unknown");
  }).pipe(Effect.provideService(SpawnExecutableResolution, (command) => `/usr/bin/${command}`)),
);

it.effect("reports no cliAuthStatus when gh is not installed", () =>
  Effect.gen(function* () {
    const discovery = yield* appSignedInDiscovery(() => Effect.die("gh must not be spawned"));
    const result = yield* discovery.probe("/repo");
    assert.strictEqual(result.auth.status, "authenticated");
    assert.isUndefined(result.auth.cliAuthStatus);
  }).pipe(Effect.provideService(SpawnExecutableResolution, () => undefined)),
);
