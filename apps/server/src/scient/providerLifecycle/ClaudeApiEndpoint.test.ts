import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings, type OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { checkClaudeProviderStatus } from "../../provider/ClaudeProvider.ts";
import { resolveClaudeApiEndpoint, withClaudeApiEndpoint } from "./ClaudeApiEndpoint.ts";

const encoder = new TextEncoder();
const settings = Schema.decodeSync(ClaudeSettings)({});

const cliLayer = (answers: Record<string, string>) =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const joined = (command as unknown as { args: ReadonlyArray<string> }).args.join(" ");
        const stdout = answers[joined];
        if (stdout === undefined) return Effect.die(`Unexpected Claude command: ${joined}`);
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(encoder.encode(stdout)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      }),
    ),
  );

const capabilities = () =>
  Effect.succeed({
    email: undefined,
    subscriptionType: undefined,
    tokenSource: "ANTHROPIC_AUTH_TOKEN",
    apiKeySource: "none",
    apiProvider: "firstParty",
    slashCommands: [],
  });

const failure = (message: string): OrchestrationV2ProviderFailure => ({
  class: "provider_error",
  message,
  code: "api_error_404",
  retryable: null,
});

describe("resolveClaudeApiEndpoint", () => {
  it("names a custom endpoint from the environment by origin only", () => {
    assert.deepStrictEqual(
      resolveClaudeApiEndpoint(
        {},
        { ANTHROPIC_BASE_URL: "https://user:secret@proxy.example:8443/v1?key=abc" },
      ),
      {
        origin: "https://proxy.example:8443",
        scheme: "https",
        host: "proxy.example",
        port: 8443,
        source: "environment",
      },
    );
  });

  it("prefers Claude's settings over the environment, as the CLI does", () => {
    assert.deepStrictEqual(
      resolveClaudeApiEndpoint(
        { ANTHROPIC_BASE_URL: "http://127.0.0.1:3456" },
        { ANTHROPIC_BASE_URL: "https://proxy.example" },
      ),
      {
        origin: "http://127.0.0.1:3456",
        scheme: "http",
        host: "127.0.0.1",
        port: 3456,
        source: "claude-settings",
      },
    );
    assert.strictEqual(
      resolveClaudeApiEndpoint(
        { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
        { ANTHROPIC_BASE_URL: "https://proxy.example" },
      ),
      undefined,
    );
  });

  it("ignores Anthropic's own API and values that are not web addresses", () => {
    for (const baseUrl of [undefined, "", "https://api.anthropic.com", "proxy.example/api"]) {
      assert.strictEqual(resolveClaudeApiEndpoint({}, { ANTHROPIC_BASE_URL: baseUrl }), undefined);
    }
  });
});

describe("withClaudeApiEndpoint", () => {
  const endpoint = resolveClaudeApiEndpoint(
    { ANTHROPIC_BASE_URL: "https://user:secret@proxy.example/v1" },
    {},
  )!;

  it("keeps the provider's own message and records where the request went", () => {
    const marked = withClaudeApiEndpoint(failure("API Error: 404 model not found"), endpoint);
    assert.deepStrictEqual(marked, {
      ...failure("API Error: 404 model not found"),
      customEndpoint: { origin: "https://proxy.example", source: "claude-settings" },
    });
  });

  it("leaves turns without a failure or without a custom endpoint alone", () => {
    assert.strictEqual(withClaudeApiEndpoint(null, endpoint), null);
    const plain = failure("API Error: 500");
    assert.strictEqual(withClaudeApiEndpoint(plain, undefined), plain);
  });
});

describe("Claude status names where a custom endpoint was set", () => {
  it.effect("from the environment", () =>
    Effect.gen(function* () {
      const status = yield* checkClaudeProviderStatus(settings, capabilities, {
        ANTHROPIC_BASE_URL: "https://proxy.example:8443/v1",
      }).pipe(Effect.provide(cliLayer({ "--version": "2.1.302 (Claude Code)\n" })));
      assert.strictEqual(status.status, "ready");
      assert.strictEqual(status.auth.type, "customEndpoint");
      assert.strictEqual(status.auth.endpoint, "https://proxy.example:8443");
      assert.strictEqual(status.auth.endpointSource, "environment");
    }),
  );

  it.effect("from Claude's settings.json", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-claude-" });
      yield* fileSystem.writeFileString(
        path.join(configDir, "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3456" } }),
      );
      const status = yield* checkClaudeProviderStatus(
        { ...settings, homePath: configDir },
        capabilities,
        {},
      ).pipe(
        Effect.provide(
          cliLayer({
            "--version": "2.1.302 (Claude Code)\n",
            "auth status --json": '{"loggedIn":true,"authMethod":"claude.ai"}\n',
          }),
        ),
      );
      assert.strictEqual(status.auth.type, "customEndpoint");
      assert.strictEqual(status.auth.endpoint, "http://127.0.0.1:3456");
      assert.strictEqual(status.auth.endpointSource, "claude-settings");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("not for a first-party account", () =>
    Effect.gen(function* () {
      const status = yield* checkClaudeProviderStatus(
        settings,
        () =>
          Effect.succeed({
            email: "person@example.com",
            subscriptionType: "max",
            tokenSource: "claude.ai",
            apiKeySource: undefined,
            apiProvider: "firstParty",
            slashCommands: [],
          }),
        {},
      ).pipe(
        Effect.provide(
          cliLayer({
            "--version": "2.1.302 (Claude Code)\n",
            "auth status --json": '{"loggedIn":true,"authMethod":"claude.ai"}\n',
          }),
        ),
      );
      assert.strictEqual(status.auth.status, "authenticated");
      assert.strictEqual(status.auth.endpointSource, undefined);
    }),
  );
});
