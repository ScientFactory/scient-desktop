import { assert, describe, it } from "@effect/vitest";
import type { OmpRpcNotification } from "effect-omp-rpc/client";
import {
  OmpRpcCommandError,
  OmpRpcProcessExitedError,
  type OmpRpcError,
} from "effect-omp-rpc/errors";
import type { OmpRpcResponse } from "effect-omp-rpc/schema";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  makeScientAgentConnectionActions,
  readScientAgentAccounts,
  type ScientAgentSignInClient,
} from "./ScientAgentConnectionActions.ts";

const response = (command: string, data: unknown = {}): OmpRpcResponse =>
  ({ type: "response", command, success: true, data }) as OmpRpcResponse;

const uiRequest = (fields: Record<string, unknown>): OmpRpcNotification =>
  ({
    _tag: "Event",
    event: { type: "extension_ui_request", ...fields },
  }) as unknown as OmpRpcNotification;

/** A stand-in for one agent process: the test plays the agent's side. */
const makeAgent = Effect.gen(function* () {
  const events = yield* Queue.unbounded<OmpRpcNotification>();
  const login = yield* Deferred.make<OmpRpcResponse, OmpRpcError>();
  const commands = yield* Ref.make<ReadonlyArray<Record<string, unknown>>>([]);
  const answers = yield* Ref.make<ReadonlyArray<Record<string, unknown>>>([]);
  const opened = yield* Ref.make(0);
  const client: ScientAgentSignInClient = {
    events: Stream.fromQueue(events),
    command: (body) =>
      Ref.update(commands, (previous) => [...previous, body]).pipe(
        Effect.andThen(
          body.type === "login" ? Deferred.await(login) : Effect.succeed(response(body.type)),
        ),
      ),
    extensionUiResponse: (answer) => Ref.update(answers, (previous) => [...previous, answer]),
    redact: (text) => text.replaceAll("sk-secret", "[REDACTED]"),
  };
  return {
    actions: makeScientAgentConnectionActions({
      open: Ref.update(opened, (count) => count + 1).pipe(Effect.as(client)),
      firstPromptTimeout: "2 seconds",
      promptSettle: "50 millis",
    }),
    say: (fields: Record<string, unknown>) => Queue.offer(events, uiRequest(fields)),
    finishLogin: Deferred.succeed(login, response("login")),
    failLogin: (detail: string) =>
      Deferred.fail(login, new OmpRpcCommandError({ command: "login", detail })),
    commands,
    answers,
    opened,
  };
});

const start = (
  agent: Effect.Success<typeof makeAgent>,
  account: string | undefined = "openai-codex",
) => agent.actions.start("scient_agent_account", account);

describe("Scient Agent sign-in", () => {
  it.live("opens the agent's link and hands a pasted answer back to it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* makeAgent;
        const starting = yield* start(agent).pipe(Effect.forkChild);
        yield* agent.say({
          id: "ui-1",
          method: "open_url",
          url: "https://auth.example.com/authorize?state=abc",
          launchUrl: "http://localhost:1455/launch",
        });
        yield* agent.say({
          id: "ui-2",
          method: "input",
          title: "Paste the authorization code (or full redirect URL):",
        });
        const attempt = yield* Fiber.join(starting);

        assert.deepStrictEqual(yield* Ref.get(agent.commands), [
          { type: "login", providerId: "openai-codex" },
        ]);
        assert.strictEqual(
          attempt.authorizationUrl,
          "https://auth.example.com/authorize?state=abc",
        );
        assert.strictEqual(attempt.authorizationUrlKind, "primary");
        assert.strictEqual(attempt.initialStatus, "waiting_for_browser");
        assert.strictEqual(
          attempt.instructions,
          "Paste the authorization code (or full redirect URL):",
        );
        assert.strictEqual(attempt.userCode, undefined);

        yield* attempt.submitAuthorizationCode!("the-code");
        assert.deepStrictEqual(yield* Ref.get(agent.answers), [{ id: "ui-2", value: "the-code" }]);
        // The question is answered once.
        const again = yield* attempt.submitAuthorizationCode!("again").pipe(Effect.flip);
        assert.strictEqual(again.message, "Scient Agent is not waiting for an answer.");

        yield* agent.finishLogin;
        yield* attempt.waitForCompletion;
      }),
    ),
  );

  it.live("shows a device flow's code and offers no answer field", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* makeAgent;
        const starting = yield* start(agent, "openai-codex-device").pipe(Effect.forkChild);
        yield* agent.say({ id: "ui-0", method: "notify", message: "Initiating…" });
        yield* agent.say({
          id: "ui-1",
          method: "open_url",
          url: "https://auth.openai.com/codex/device",
          instructions: "Enter code: A2L1-00QJC",
        });
        const attempt = yield* Fiber.join(starting);

        assert.strictEqual(attempt.initialStatus, "waiting_for_device_code");
        assert.strictEqual(attempt.userCode, "A2L1-00QJC");
        assert.strictEqual(attempt.instructions, "Enter code: A2L1-00QJC");
        assert.strictEqual(attempt.submitAuthorizationCode, undefined);
      }),
    ),
  );

  it.live("asks for a key with the agent's own wording", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* makeAgent;
        const starting = yield* start(agent, "deepseek").pipe(Effect.forkChild);
        yield* agent.say({
          id: "ui-1",
          method: "open_url",
          url: "https://platform.deepseek.com/api_keys",
          instructions: "Create or copy your API key from the DeepSeek dashboard",
        });
        yield* agent.say({ id: "ui-2", method: "input", title: "Paste your DeepSeek API key" });
        const attempt = yield* Fiber.join(starting);

        assert.strictEqual(attempt.instructions, "Paste your DeepSeek API key");
        assert.strictEqual(attempt.userCode, undefined);
        assert.notStrictEqual(attempt.submitAuthorizationCode, undefined);
      }),
    ),
  );

  it.live("does not hand a link to the browser unless it is https", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* makeAgent;
        const starting = yield* start(agent).pipe(Effect.forkChild);
        yield* agent.say({ id: "ui-1", method: "open_url", url: "http://localhost:1455/launch" });
        const attempt = yield* Fiber.join(starting);
        assert.strictEqual(attempt.authorizationUrl, undefined);
      }),
    ),
  );

  it.live("reports the agent's reason when the sign-in fails, without its secrets", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* makeAgent;
        const starting = yield* start(agent).pipe(Effect.forkChild);
        yield* agent.say({ id: "ui-1", method: "open_url", url: "https://auth.example.com/" });
        const attempt = yield* Fiber.join(starting);
        yield* agent.failLogin("Token exchange failed for sk-secret:\n  invalid_grant");
        const failure = yield* attempt.waitForCompletion.pipe(Effect.flip);
        assert.strictEqual(failure.message, "Token exchange failed for [REDACTED]: invalid_grant");
      }),
    ),
  );

  it.live("removes what the user pasted from the agent's error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* makeAgent;
        const starting = yield* start(agent, "deepseek").pipe(Effect.forkChild);
        yield* agent.say({ id: "ui-1", method: "input", title: "Paste your DeepSeek API key" });
        const attempt = yield* Fiber.join(starting);
        // Nothing the process started with tells its redaction about this value.
        yield* attempt.submitAuthorizationCode!("  plain-pasted-credential  ");
        yield* agent.failLogin(
          "Key plain-pasted-credential was rejected (plain-pasted-credential)",
        );
        const failure = yield* attempt.waitForCompletion.pipe(Effect.flip);
        assert.strictEqual(failure.message, "Key [REDACTED] was rejected ([REDACTED])");
        // The agent's error object, which carries the value, is not kept either.
        assert.strictEqual(failure.cause, undefined);
      }),
    ),
  );

  it.live("takes a first question that arrives after the link was described", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* makeAgent;
        const starting = yield* start(agent).pipe(Effect.forkChild);
        yield* agent.say({ id: "ui-1", method: "open_url", url: "https://auth.example.com/" });
        const attempt = yield* Fiber.join(starting);
        assert.strictEqual(attempt.submitAuthorizationCode, undefined);

        const later = yield* attempt.laterQuestion!.pipe(Effect.forkChild);
        yield* agent.say({ id: "ui-0", method: "open_url", url: "https://auth.example.com/again" });
        yield* agent.say({ id: "ui-2", method: "input", title: "Paste the redirect URL" });
        const question = yield* Fiber.join(later);
        assert.strictEqual(question.instructions, "Paste the redirect URL");
        yield* question.submitAuthorizationCode("https://localhost/callback?code=1");
        assert.deepStrictEqual(yield* Ref.get(agent.answers), [
          { id: "ui-2", value: "https://localhost/callback?code=1" },
        ]);
      }),
    ),
  );

  it.live("fails the start when the agent refuses before asking anything", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* makeAgent;
        yield* agent.failLogin("Unknown OAuth provider: nope");
        const failure = yield* start(agent, "nope").pipe(Effect.flip);
        assert.strictEqual(failure.message, "Unknown OAuth provider: nope");
      }),
    ),
  );

  it.live("goes straight to verification when the agent finishes without asking", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* makeAgent;
        yield* agent.finishLogin;
        const attempt = yield* start(agent);
        assert.strictEqual(attempt.initialStatus, "verifying");
        yield* attempt.waitForCompletion;
      }),
    ),
  );

  it.live("gives up when the agent never begins", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* makeAgent;
        const actions = makeScientAgentConnectionActions({
          open: Effect.succeed({
            events: Stream.never,
            command: () => Effect.never,
            extensionUiResponse: () => Effect.void,
            redact: (text) => text,
          }),
          firstPromptTimeout: "50 millis",
        });
        const failure = yield* actions
          .start("scient_agent_account", "openai-codex")
          .pipe(Effect.flip);
        assert.strictEqual(failure.message, "Scient Agent did not begin the sign in. Try again.");
        assert.strictEqual(yield* Ref.get(agent.opened), 0);
      }),
    ),
  );

  it.live("fails a sign-in that asks a second question after the first was answered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* makeAgent;
        const starting = yield* start(agent, "perplexity").pipe(Effect.forkChild);
        yield* agent.say({ id: "ui-1", method: "input", title: "Email address" });
        const attempt = yield* Fiber.join(starting);
        assert.strictEqual(attempt.instructions, "Email address");
        yield* attempt.submitAuthorizationCode!("someone@example.com");
        yield* agent.say({ id: "ui-2", method: "input", title: "One-time code" });
        const failure = yield* attempt.waitForCompletion.pipe(Effect.flip);
        assert.match(failure.message, /more than one question/u);
      }),
    ),
  );

  it.live("starts nothing without a named account or for another method", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* makeAgent;
        yield* agent.actions.start("scient_agent_account").pipe(Effect.flip);
        yield* agent.actions.start("codex_browser", "openai-codex").pipe(Effect.flip);
        assert.strictEqual(yield* Ref.get(agent.opened), 0);
      }),
    ),
  );

  it.live("stops the agent's sign-in when the attempt is cancelled", () =>
    Effect.gen(function* () {
      const agent = yield* makeAgent;
      const scope = yield* Scope.make();
      const starting = yield* start(agent).pipe(Scope.provide(scope), Effect.forkChild);
      yield* agent.say({ id: "ui-1", method: "open_url", url: "https://auth.example.com/" });
      const attempt = yield* Fiber.join(starting);
      const waiting = yield* attempt.waitForCompletion.pipe(Effect.exit, Effect.forkChild);
      yield* attempt.cancel;
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.join(waiting)));
    }),
  );

  it.live("says whether a failed sign-out may still have removed the sign-in", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failing = (error: OmpRpcError) =>
          makeScientAgentConnectionActions({
            open: Effect.succeed({
              events: Stream.never,
              command: () => Effect.fail(error),
              extensionUiResponse: () => Effect.void,
              redact: (text) => text,
            }),
          }).disconnectAccount!("openai-codex").pipe(Effect.flip);

        // The agent answered: it kept the sign-in.
        const refused = yield* failing(
          new OmpRpcCommandError({ command: "logout", detail: "store is locked" }),
        );
        assert.strictEqual(refused.message, "store is locked");
        assert.strictEqual(refused.signInMayBeRemoved, false);

        // It never answered, or its process ended: nothing says what it did.
        const silent = yield* failing(
          new OmpRpcCommandError({ command: "logout", detail: "timed out", code: "timeout" }),
        );
        assert.strictEqual(silent.signInMayBeRemoved, true);
        const gone = yield* failing(new OmpRpcProcessExitedError({ detail: "exited with code 1" }));
        assert.strictEqual(gone.signInMayBeRemoved, true);
      }),
    ),
  );

  it.live("signs out of one account in its own agent process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* makeAgent;
        yield* agent.actions.disconnectAccount!("openai-codex");
        assert.deepStrictEqual(yield* Ref.get(agent.commands), [
          { type: "logout", providerId: "openai-codex" },
        ]);
        // There is no provider-wide sign-out to run by mistake.
        yield* agent.actions.disconnect.pipe(Effect.flip);
      }),
    ),
  );
});

describe("readScientAgentAccounts", () => {
  const listing = (providers: ReadonlyArray<Record<string, unknown>>) =>
    readScientAgentAccounts({
      command: () => Effect.succeed(response("get_login_providers", { providers })),
    });

  it.effect("maps the agent's list to accounts", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* listing([
          {
            id: "openai-codex",
            name: " ChatGPT Plus/Pro ",
            available: true,
            authenticated: true,
            kind: "account",
            stored: true,
          },
          {
            id: "deepseek",
            name: "DeepSeek",
            available: true,
            authenticated: true,
            kind: "key",
            stored: false,
          },
        ]),
        [
          {
            id: "openai-codex",
            name: "ChatGPT Plus/Pro",
            kind: "account",
            connected: true,
            canDisconnect: true,
          },
          { id: "deepseek", name: "DeepSeek", kind: "key", connected: true, canDisconnect: false },
        ],
      );
    }),
  );

  it.effect("links two entries that keep one stored sign-in, and only those", () =>
    Effect.gen(function* () {
      const accounts = yield* listing([
        {
          id: "openai-codex",
          name: "ChatGPT",
          authenticated: true,
          kind: "account",
          stored: true,
          store: "openai-codex",
        },
        {
          id: "openai-codex-device",
          name: "ChatGPT (device)",
          authenticated: true,
          kind: "account",
          stored: true,
          store: "openai-codex",
        },
        // A store that names no entry on the list links nothing.
        {
          id: "zai-coding-plan",
          name: "Z.ai Coding Plan",
          authenticated: false,
          kind: "key",
          stored: false,
          store: "zai",
        },
        // An agent build that predates `store`.
        { id: "deepseek", name: "DeepSeek", authenticated: false, kind: "key", stored: false },
      ]);
      assert.deepStrictEqual(
        accounts?.map((entry) => [entry.id, entry.sameAccountAs]),
        [
          ["openai-codex", undefined],
          ["openai-codex-device", "openai-codex"],
          ["zai-coding-plan", undefined],
          ["deepseek", undefined],
        ],
      );
    }),
  );

  it.effect("leaves out an entry whose id Scient could not send back", () =>
    Effect.gen(function* () {
      const accounts = yield* listing([
        { id: "has space", name: "Odd", authenticated: false, kind: "account", stored: false },
        { id: "llama.cpp", name: "llama.cpp", authenticated: false, kind: "key", stored: false },
      ]);
      assert.deepStrictEqual(
        accounts?.map((entry) => entry.id),
        ["llama.cpp"],
      );
    }),
  );

  it.effect("offers no sign-in for an agent build that does not describe its entries", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* listing([
          { id: "openai-codex", name: "ChatGPT", available: true, authenticated: false },
        ]),
        undefined,
      );
      assert.strictEqual(yield* listing([]).pipe(Effect.map((accounts) => accounts?.length)), 0);
      assert.strictEqual(
        yield* readScientAgentAccounts({
          command: () =>
            Effect.fail(new OmpRpcCommandError({ command: "get_login_providers", detail: "no" })),
        }),
        undefined,
      );
    }),
  );
});
