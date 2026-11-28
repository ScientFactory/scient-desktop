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
  /** The passwords Scient typed, by origin: their capture is Scient's echo, not the person. */
  readonly scientTyped: Map<string, Array<Redacted.Redacted<string>>>;
  submitted: number;
  /** Set once the sign-in worked: what arrives after can't be the password it followed. */
  signedIn: boolean;
  candidate?: {
    readonly origin: string;
    readonly username: string;
    readonly password: Redacted.Redacted<string>;
    readonly at: number;
    /** The page load it was submitted from, when one was seen on its origin. */
    readonly document?: number | undefined;
    /** That load already said it refused a password when this one was submitted from it. */
    readonly refusedBefore?: boolean;
  };
  seen: number;
  /** The page load each origin last showed. */
  documents?: Map<string, number>;
  /** The page load each origin last showed saying it refused a password, while it says so. */
  refusals?: Map<string, number>;
  /** The site answered the last submitted password with its form again: it refused it. */
  refusedBack?: boolean;
}

/**
 * Notes a page an attempt looked at. The site refused the person's password only when a new page
 * load on that origin, its answer, shows the form again with no check in the way: the same page
 * may still be waiting for the answer, and a CAPTCHA holds the form whatever the password.
 */
export function notePage(
  typed: Typed,
  page: { readonly origin: string; readonly password: boolean; readonly captcha: boolean },
  document: number | undefined,
) {
  typed.documents ??= new Map();
  const { candidate } = typed;
  const answer =
    document !== undefined &&
    typed.documents.get(page.origin) !== document &&
    candidate?.origin === page.origin &&
    candidate.document !== undefined &&
    candidate.document !== document;
  if (answer) typed.refusedBack = page.password && !page.captcha;
  if (document !== undefined) typed.documents.set(page.origin, document);
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
    /** By registrable site: the sign-ins running now. Two at once can't tell whose a code is. */
    readonly codeWaits: Map<string, Set<string>>;
    /** Messages and digits that went into a page, until when they stay used. */
    readonly usedCodes: Map<string, number>;
    /** By site: senders whose code the site accepted, so a code from them can go in by itself. */
    readonly codeSenders: Map<string, Set<string>>;
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
  const codeWaits = new Map<string, Set<string>>();
  const usedCodes = new Map<string, number>();
  const codeSenders = new Map<string, Set<string>>();
  const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();
  return SignInAttempts.of({
    pending,
    typed,
    codeWaits,
    usedCodes,
    codeSenders,
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
