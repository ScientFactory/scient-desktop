import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import type { AccountId, PreviewTabId } from "@t3tools/contracts";

import type { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import type { SignInSubmission } from "../signIn/decision.ts";

type Invocation = AgentInvocationContext["Service"];

/**
 * An attempt stopped at a second factor, kept with its tab and what it submitted, so the next
 * press or agent call in its thread resumes it instead of typing the password again. In memory:
 * a restart ends it.
 */
export interface Pending {
  readonly attemptId: string;
  readonly accountId: AccountId;
  readonly invocation: Invocation;
  readonly tabId: PreviewTabId;
  readonly submissions: ReadonlyArray<SignInSubmission>;
  readonly submittedAt?: number | undefined;
}

/**
 * What one attempt saw and the user typed in its tab, in order. Only the one password typed before
 * the sign-in finished, with no field back on its page and nothing asked elsewhere since, is kept,
 * unverified; anything less keeps nothing. Values stay here until kept or the attempt ends.
 */
export interface Typed {
  readonly threadId: string;
  readonly tabId: PreviewTabId;
  readonly sites: ReadonlyArray<string>;
  readonly university: boolean;
  readonly accountId: AccountId;
  /** When each origin last asked for anything, and for a password, in the order of `seen`. */
  readonly fieldsSeen: Map<string, number>;
  readonly passwordSeen: Map<string, number>;
  /** Every origin the tab reached, a single sign-on service's included: the user's until it ends. */
  readonly visited: Set<string>;
  readonly scientTyped: Set<string>;
  submitted: number;
  /** Set once the sign-in worked: what arrives after can't be the password it followed. */
  signedIn: boolean;
  candidate?: {
    readonly origin: string;
    readonly username: string;
    readonly password: Redacted.Redacted<string>;
    readonly at: number;
  };
  seen: number;
}

/**
 * The sign-in executor's state for the server's life: one lock per real site and identity,
 * attempts kept at a second factor, and what a person typed in an attempt's tab. A lock nobody
 * holds or waits for is dropped; typed values are dropped at shutdown.
 */
export class SignInAttempts extends Context.Service<
  SignInAttempts,
  {
    readonly pending: Map<string, Pending>;
    readonly typed: Map<string, Typed>;
    /** Runs `effect` as the only attempt on `key`; others on that key wait their turn. */
    readonly exclusive: <A, E, R>(
      key: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** Keys with a lock now: held, or waited for. */
    readonly lockedKeys: () => ReadonlyArray<string>;
  }
>()("t3/scient/accounts/agent/signInAttempts") {}

/** The state alone, for a store that has no server lifetime, such as a test's. */
export function makeSignInAttempts(): SignInAttempts["Service"] {
  const pending = new Map<string, Pending>();
  const typed = new Map<string, Typed>();
  const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();
  return SignInAttempts.of({
    pending,
    typed,
    exclusive: Effect.fn("SignInAttempts.exclusive")(function* <A, E, R>(
      key: string,
      effect: Effect.Effect<A, E, R>,
    ) {
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const entry = locks.get(key) ?? { lock: Semaphore.makeUnsafe(1), users: 0 };
          locks.set(key, entry);
          entry.users++;
          return entry;
        }),
        (entry) => entry.lock.withPermits(1)(effect),
        (entry) =>
          Effect.sync(() => {
            entry.users--;
            if (entry.users === 0 && locks.get(key) === entry) locks.delete(key);
          }),
      );
    }),
    lockedKeys: () => [...locks.keys()],
  });
}

export const layer = Layer.effect(
  SignInAttempts,
  Effect.gen(function* () {
    const attempts = makeSignInAttempts();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        attempts.typed.clear();
        attempts.pending.clear();
      }),
    );
    return attempts;
  }),
);
