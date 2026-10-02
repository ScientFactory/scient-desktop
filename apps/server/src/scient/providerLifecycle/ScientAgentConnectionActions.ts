/**
 * Scient Agent account sign-in over the agent's own RPC.
 *
 * The agent owns every sign-in flow, its credentials and their storage. Scient
 * starts one isolated agent process per attempt, asks it to sign in to one
 * entry of its own list, shows the link and the question it sends, and hands a
 * pasted answer straight back to that process. Nothing the user pastes is kept
 * in Scient's state. The process lives in the attempt's scope.
 */
import type { ProviderConnectionAccount, ProviderConnectionMethod } from "@t3tools/contracts";
import type { OmpRpcClient } from "effect-omp-rpc/client";
import { OmpRpcCommandError } from "effect-omp-rpc/errors";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type {
  ProviderConnectionActionFailure,
  ProviderConnectionActions,
  ProviderConnectionAttempt,
} from "../../provider/ProviderDriver.ts";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";

const SCIENT_AGENT_ACCOUNT_METHOD = "scient_agent_account" satisfies ProviderConnectionMethod;

/** How long the agent has to send its first link or question, or finish. */
const FIRST_PROMPT_TIMEOUT: Duration.Input = "30 seconds";
/**
 * A sign-in sends its link and its question together. Once one arrived, the
 * other is waited for this long before the attempt is described to the user.
 */
const PROMPT_SETTLE: Duration.Input = "400 millis";
const MAX_AUTHORIZATION_URL_LENGTH = 8_192;
const MAX_INSTRUCTIONS_LENGTH = 512;

/** What a sign-in attempt needs from one agent process. */
export interface ScientAgentSignInClient {
  readonly events: OmpRpcClient["events"];
  readonly command: OmpRpcClient["command"];
  readonly extensionUiResponse: OmpRpcClient["extensionUiResponse"];
  /** Redacts what the process knows before its text reaches a message. */
  readonly redact: (text: string) => string;
}

const isCommandError = Schema.is(OmpRpcCommandError);

const connectionError = (message: string, cause?: unknown) =>
  new ProviderConnectionActionError({ message, ...(cause === undefined ? {} : { cause }) });

const SignInList = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      authenticated: Schema.Boolean,
      // Absent from an agent build that predates sign-in from a host.
      kind: Schema.optional(Schema.Literals(["account", "key"])),
      stored: Schema.optional(Schema.Boolean),
    }),
  ),
});
const decodeSignInList = Schema.decodeUnknownOption(SignInList);
const isAccountId = (id: string) => id.length <= 128 && /^[A-Za-z0-9._-]+$/u.test(id);

/**
 * The agent's sign-in list as Scient shows it. `undefined` when the agent does
 * not describe its entries, so an older build offers no sign-in rather than a
 * list Scient cannot present truthfully.
 */
export const readScientAgentAccounts = (
  client: Pick<ScientAgentSignInClient, "command">,
): Effect.Effect<ReadonlyArray<ProviderConnectionAccount> | undefined> =>
  client.command({ type: "get_login_providers" }).pipe(
    Effect.map((response) => {
      const list = decodeSignInList(response.data);
      if (Option.isNone(list)) return undefined;
      const accounts: Array<ProviderConnectionAccount> = [];
      for (const entry of list.value.providers) {
        if (entry.kind === undefined || entry.stored === undefined) return undefined;
        const name = entry.name.trim().slice(0, 128);
        if (!isAccountId(entry.id) || name.length === 0) continue;
        accounts.push({
          id: entry.id,
          name,
          kind: entry.kind,
          connected: entry.authenticated,
          canDisconnect: entry.stored,
        });
      }
      return accounts;
    }),
    Effect.orElseSucceed(() => undefined),
  );

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

/** The agent's link, kept only when it is one a browser can open safely. */
const authorizationUrl = (value: string | undefined): string | undefined => {
  if (!value || value.length > MAX_AUTHORIZATION_URL_LENGTH || hasControlCharacter(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

/** The agent's own wording, on one line and bounded. */
const instructionsText = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  let line = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    line += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : character;
  }
  const text = line.replace(/\s+/gu, " ").trim().slice(0, MAX_INSTRUCTIONS_LENGTH).trim();
  return text.length > 0 ? text : undefined;
};

/** A device flow names its code in the instructions that come with the link. */
const deviceCode = (instructions: string | undefined): string | undefined => {
  const match = /\bcode:?\s+([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\s*$/iu.exec(instructions ?? "");
  const code = match?.[1];
  return code !== undefined && code.length >= 4 && code.length <= 64 ? code : undefined;
};

type Prompt =
  | { readonly _tag: "Link"; readonly url: string | undefined; readonly instructions?: string }
  | { readonly _tag: "Question"; readonly title: string | undefined };

export function makeScientAgentConnectionActions(input: {
  /** Starts one isolated agent process in the caller's scope. */
  readonly open: Effect.Effect<
    ScientAgentSignInClient,
    ProviderConnectionActionFailure,
    Scope.Scope
  >;
  readonly firstPromptTimeout?: Duration.Input;
  readonly promptSettle?: Duration.Input;
}): ProviderConnectionActions {
  const start = (
    method: ProviderConnectionMethod,
    account?: string,
  ): Effect.Effect<ProviderConnectionAttempt, ProviderConnectionActionFailure, Scope.Scope> =>
    Effect.gen(function* () {
      if (method !== SCIENT_AGENT_ACCOUNT_METHOD || account === undefined) {
        return yield* connectionError("Choose an account from Scient Agent's sign-in list.");
      }
      const scope = yield* Scope.Scope;
      const client = yield* input.open;
      const prompts = yield* Queue.unbounded<Prompt>();
      const openQuestion = yield* Ref.make<string | undefined>(undefined);
      const answered = yield* Ref.make(false);
      // What the user pasted is a credential the process did not start with,
      // so its own redaction does not know it. The agent may echo it in an error.
      const pasted = yield* Ref.make<ReadonlyArray<string>>([]);
      const withoutPasted = (text: string) =>
        Ref.get(pasted).pipe(
          Effect.map((values) =>
            values.reduce((next, value) => next.split(value).join("[REDACTED]"), text),
          ),
        );
      const unsupported = yield* Deferred.make<never, ProviderConnectionActionFailure>();

      yield* client.events.pipe(
        Stream.runForEach((notification) => {
          if (notification._tag !== "Event") return Effect.void;
          const event = notification.event;
          if (event.type !== "extension_ui_request") return Effect.void;
          if (event.method === "open_url") {
            return Queue.offer(prompts, {
              _tag: "Link",
              url: authorizationUrl(event.url),
              ...(event.instructions ? { instructions: event.instructions } : {}),
            });
          }
          if (event.method === "input" && event.id) {
            const id = event.id;
            return Effect.gen(function* () {
              yield* Ref.set(openQuestion, id);
              if (yield* Ref.get(answered)) {
                // One answer is all the sign-in screen can collect.
                yield* Deferred.fail(
                  unsupported,
                  connectionError(
                    "This sign-in asks more than one question, which Scient cannot show yet. Use `scient-agent login` in a terminal for it.",
                  ),
                );
                return;
              }
              yield* Queue.offer(prompts, { _tag: "Question", title: event.title });
            });
          }
          return Effect.void;
        }),
        Effect.ignore,
        Effect.forkIn(scope),
      );

      const login = yield* client.command({ type: "login", providerId: account }).pipe(
        Effect.asVoid,
        // The cause is not kept: it can carry what the user pasted.
        Effect.catch((cause) =>
          withoutPasted(cause.message).pipe(
            Effect.flatMap((message) =>
              Effect.fail(
                connectionError(
                  instructionsText(client.redact(message)) ??
                    "Scient Agent could not complete the sign in.",
                ),
              ),
            ),
          ),
        ),
        Effect.forkIn(scope),
      );
      const completion = Effect.raceFirst(Fiber.join(login), Deferred.await(unsupported));

      const first = yield* Effect.raceFirst(
        Queue.take(prompts).pipe(Effect.map((prompt) => Option.some(prompt))),
        completion.pipe(Effect.as(Option.none<Prompt>())),
      ).pipe(
        Effect.timeoutOrElse({
          duration: input.firstPromptTimeout ?? FIRST_PROMPT_TIMEOUT,
          orElse: () =>
            Effect.fail(connectionError("Scient Agent did not begin the sign in. Try again.")),
        }),
      );
      const cancel = Fiber.interrupt(login).pipe(Effect.asVoid);
      if (Option.isNone(first)) {
        // Already signed in, or finished without asking anything.
        return { initialStatus: "verifying", waitForCompletion: Effect.void, cancel };
      }

      let link: Extract<Prompt, { _tag: "Link" }> | undefined;
      let question: Extract<Prompt, { _tag: "Question" }> | undefined;
      const take = (prompt: Prompt) => {
        if (prompt._tag === "Link") link ??= prompt;
        else question ??= prompt;
      };
      take(first.value);
      while (link === undefined || question === undefined) {
        const next = yield* Queue.take(prompts).pipe(
          Effect.timeoutOption(input.promptSettle ?? PROMPT_SETTLE),
        );
        if (Option.isNone(next)) break;
        take(next.value);
      }

      const linkInstructions = instructionsText(link?.instructions);
      const userCode = deviceCode(linkInstructions);
      const instructions = instructionsText(question?.title) ?? linkInstructions;
      const submitAuthorizationCode = (code: string) =>
        Effect.gen(function* () {
          const id = yield* Ref.getAndSet(openQuestion, undefined);
          if (id === undefined) {
            return yield* connectionError("Scient Agent is not waiting for an answer.");
          }
          yield* Ref.set(answered, true);
          const value = code.trim();
          if (value.length > 0) {
            yield* Ref.update(pasted, (values) =>
              // Longest first, so a value that contains another is replaced whole.
              [...values, value].toSorted((left, right) => right.length - left.length),
            );
          }
          yield* client
            .extensionUiResponse({ id, value: code })
            .pipe(
              Effect.mapError((cause) =>
                connectionError("Scient could not hand the answer to Scient Agent.", cause),
              ),
            );
        });

      // A first question can also come after the link was described.
      const laterQuestion = Effect.gen(function* () {
        while (true) {
          const prompt = yield* Queue.take(prompts);
          if (prompt._tag === "Question") {
            return { instructions: instructionsText(prompt.title), submitAuthorizationCode };
          }
        }
      });

      return {
        ...(link?.url ? { authorizationUrl: link.url, authorizationUrlKind: "primary" } : {}),
        initialStatus: userCode ? "waiting_for_device_code" : "waiting_for_browser",
        ...(userCode ? { userCode } : {}),
        ...(instructions ? { instructions } : {}),
        ...(question ? { submitAuthorizationCode } : { laterQuestion }),
        waitForCompletion: completion,
        cancel,
      } satisfies ProviderConnectionAttempt;
    });

  return {
    methods: [SCIENT_AGENT_ACCOUNT_METHOD],
    requiresAccount: true,
    start,
    // The provider has no single account: sign-out always names one entry.
    disconnect: Effect.fail(connectionError("Choose an account to sign out of.")),
    disconnectAccount: (account) =>
      Effect.gen(function* () {
        const client = yield* input.open;
        yield* client.command({ type: "logout", providerId: account }).pipe(
          Effect.mapError((cause) =>
            // The agent answering with an error means it kept the sign-in. Any
            // other failure (its process ended, it never answered) leaves that
            // unknown.
            Object.assign(
              connectionError(
                instructionsText(client.redact(cause.message)) ??
                  "Scient Agent could not sign out.",
                cause,
              ),
              { signInMayBeRemoved: !(isCommandError(cause) && cause.code !== "timeout") },
            ),
          ),
        );
      }),
  };
}
