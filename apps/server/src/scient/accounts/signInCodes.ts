import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { BackgroundPolicy } from "../../background/BackgroundPolicy.ts";
import type { CodeBoxMark } from "./signIn/engine.ts";

/** The second step a sign-in met: none, only the saved authenticator key, or a code or push sent. */
export type SignInFactor = "none" | "totp" | "code";

/**
 * Whether signing in may text, mail or push the person a code: only a sign-in Scient saw finish
 * with no second step, or with the saved authenticator key alone, says it doesn't. A saved key
 * by itself proves nothing: the site may text a code beside it.
 */
export const mayAskCode = (factor: SignInFactor | undefined) =>
  factor !== "none" && factor !== "totp";

/** What the person reads before such a sign-in Scient starts by itself, so the code has context. */
export const CODE_COMING = "Signing in · a code is coming";

/** What the person reads the moment a sign-in Scient started quietly meets a code anyway. */
export const scientsCode = (site: string) => `That code is Scient signing in to ${site}`;

/** A Needs you detail that is also a phone notice (`codeNotices`), pushed once from there. */
export const isCodeNotice = (detail: string | undefined) =>
  detail === CODE_COMING || detail?.startsWith("That code is Scient signing in") === true;

/**
 * Someone is at a Scient window on any device (a foreground activity lease). Read right before
 * acting; unknown counts as nobody, so no code ever comes unasked.
 */
export const personActive = Effect.serviceOption(BackgroundPolicy).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.succeed(false),
      onSome: (policy) =>
        policy.snapshot.pipe(Effect.map((snapshot) => snapshot.activeForegroundLeaseCount > 0)),
    }),
  ),
);

/**
 * What a sign-in Scient saw says about the row's second step. A code sent from outside (a text, a
 * mail, a push), any code box the key didn't fill, on any origin of the run, and a key the site
 * refused all mark it `code`, even when the run signed in. Only the key alone is `totp`.
 */
export const factorSeen = (seen: {
  readonly sentCode: boolean;
  readonly unknownBox: boolean;
  readonly typedKey: boolean;
  readonly outcome: string;
}): SignInFactor => {
  const signedIn = seen.outcome === "signed-in";
  if (seen.sentCode) return "code";
  if (seen.typedKey && seen.outcome === "code-rejected") return "code";
  if (seen.unknownBox) return "code";
  return seen.typedKey && signedIn ? "totp" : seen.typedKey ? "code" : "none";
};

/**
 * Every code box of one sign-in (`codeBoxId`) and all seen of it, nothing forgotten. Outside: a
 * code from outside; a box the key may not answer, whatever went in later, unless the person chose
 * the key there; or one it may answer that a signed-in run got past without it.
 */
export const codeBoxes = () => {
  const boxes = new Map<string, Set<CodeBoxMark>>();
  return {
    note: (box: string, by: CodeBoxMark) => {
      const marks = boxes.get(box) ?? new Set<CodeBoxMark>();
      marks.add(by);
      boxes.set(box, marks);
    },
    outside: (signedIn: boolean) =>
      [...boxes.values()].some(
        (marks) =>
          marks.has("other") ||
          (marks.has("seen") && !marks.has("chosen")) ||
          (signedIn && marks.has("fits") && !marks.has("key") && !marks.has("chosen")),
      ),
  };
};
