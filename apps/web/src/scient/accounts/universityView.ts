import {
  ACCOUNTS_PROTOCOL_2,
  type AccountsSnapshot,
  type AccountSummary,
  type UniversitySignOut,
} from "@t3tools/contracts";
import { signedOutOnPurpose } from "@t3tools/shared/scientAccountSignIn";
import { siteOf } from "@t3tools/shared/scientSiteMatch";
import { universitiesOf } from "@t3tools/shared/scientPaperLinks";
import { universityGroups, type UniversityGroup } from "@t3tools/shared/scientUniversityGroups";
import { msg } from "gt-react";

export type UniversityStatus =
  | "signing-in"
  | "signed-in"
  | "needs-you"
  | "cancelled"
  | "failed"
  | "timed-out"
  | "signed-out"
  | "sign-out-unfinished"
  | "unclear"
  | "sign-in-needed";

export const UNIVERSITY_STATUS_LABELS: Readonly<Record<UniversityStatus, string>> = {
  "signing-in": msg("Signing in…"),
  "signed-in": msg("Signed in"),
  "needs-you": msg("Needs you"),
  cancelled: msg("Sign-in cancelled"),
  failed: msg("Sign-in failed"),
  "timed-out": msg("Sign-in timed out"),
  "signed-out": msg("Signed out"),
  "sign-out-unfinished": msg("Sign-out unfinished"),
  unclear: msg("Couldn't check"),
  "sign-in-needed": msg("Sign in needed"),
};

/**
 * Where one university stands for the Library menu. `pressed` is this window's press, with the last
 * end it knew of: under way until the server shows another end, so no two clocks are compared.
 */
export function universityStatus(
  group: UniversityGroup,
  snapshot: Pick<AccountsSnapshot, "attempts" | "signInEnds" | "universitySignOuts">,
  pressed: { readonly lastEnd: string | undefined } | undefined,
  unclear: boolean,
): UniversityStatus {
  if (signingIn(group, snapshot)) return "signing-in";
  if (pressed && pressed.lastEnd === lastEndOf(group, snapshot)) return "signing-in";
  if (group.rows.some(({ signIn }) => signIn?.state === "signed-in")) return "signed-in";
  const ended = recentEnd(group, snapshot);
  if (ended) return ended;
  if (group.rows.every(({ signIn }) => signedOutOnPurpose(signIn)))
    return openSignOut(group, snapshot) ? "sign-out-unfinished" : "signed-out";
  return unclear ? "unclear" : "sign-in-needed";
}

/**
 * A sign-in running on one of the university's rows. One kept at a second factor runs no more: it
 * waits for the person, and Sign out stays on offer.
 */
export const signingIn = (group: UniversityGroup, snapshot: Pick<AccountsSnapshot, "attempts">) =>
  snapshot.attempts?.some(
    ({ accountId, state }) =>
      state !== "pending" && group.rows.some((row) => row.accountId === accountId),
  ) === true;

/** The university's sign-out still clearing, if any: Sign out stays on offer to finish it. */
export const openSignOut = (
  group: UniversityGroup,
  snapshot: Pick<AccountsSnapshot, "universitySignOuts">,
) =>
  snapshot.universitySignOuts?.find((op) =>
    op.accountIds.some((id) => group.rows.some((row) => row.accountId === id)),
  );

/** A host of a vendor's the sign-out couldn't fully clear, to name: not a university's own site. */
export const unclearedHost = (op: UniversitySignOut | undefined) =>
  op?.pending.find(({ site }) => siteOf(site) !== site)?.site;

/**
 * How the person's latest attempt ended, while nothing has been seen since: kept apart from the
 * university's state, so a copy signed in doesn't hide a sign-in that just failed on another.
 */
export function recentEnd(group: UniversityGroup, snapshot: Pick<AccountsSnapshot, "signInEnds">) {
  const end = (snapshot.signInEnds ?? [])
    .filter(({ accountId }) => group.rows.some((row) => row.accountId === accountId))
    .toSorted((a, b) => b.at.localeCompare(a.at))[0];
  // Only a look at that attempt's own row since it ended says more than the attempt.
  const seen = group.rows.find((row) => row.accountId === end?.accountId)?.signIn?.at;
  return end && (seen === undefined || end.at >= seen) ? end.outcome : undefined;
}

/**
 * The row a university's Sign in goes through: one Scient can type a saved password into, else
 * the one signed in last, else the first. Its other rows keep their own Sign in.
 */
export function signInRow(group: UniversityGroup) {
  const lastSignedIn = (row: AccountSummary) =>
    row.signIn?.state === "signed-in" ? row.signIn.at : "";
  return group.rows.toSorted(
    (a, b) =>
      Number(b.secrets.password !== undefined) - Number(a.secrets.password !== undefined) ||
      lastSignedIn(b).localeCompare(lastSignedIn(a)),
  )[0]!;
}

/** A protocol-2 server signs universities out, keeps attempt ends and puts away unreached papers. */
export const speaksUniversityProtocol = (
  snapshot: { readonly accountsProtocol?: number | undefined } | null | undefined,
) => (snapshot?.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL_2;

/**
 * The universities to show: grouped against a server that speaks the new protocol, one per row
 * against an older one, whose rows and actions are the old row-level ones.
 */
export const shownUniversities = (
  snapshot:
    | {
        readonly accounts: ReadonlyArray<AccountSummary>;
        readonly accountsProtocol?: number | undefined;
      }
    | null
    | undefined,
) =>
  speaksUniversityProtocol(snapshot)
    ? universityGroups(snapshot?.accounts ?? [])
    : universitiesOf(snapshot?.accounts ?? []).flatMap((row) => universityGroups([row]));

/** A university waits for the person when no copy is signed in and they didn't sign out. */
export const universityWaiting = (status: UniversityStatus) =>
  status !== "signed-in" &&
  status !== "signed-out" &&
  status !== "sign-out-unfinished" &&
  status !== "signing-in";

/** The latest end the server has shown for a university, to tell a press's own end apart. */
export const lastEndOf = (group: UniversityGroup, snapshot: Pick<AccountsSnapshot, "signInEnds">) =>
  (snapshot.signInEnds ?? [])
    .filter(({ accountId }) => group.rows.some((row) => row.accountId === accountId))
    .map(({ at }) => at)
    .toSorted()
    .at(-1);
