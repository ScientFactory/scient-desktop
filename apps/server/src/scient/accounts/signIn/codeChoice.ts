import type { CodeCandidate } from "./messageCodes.ts";

/** A message or its digits already went into a page: neither is offered again. */
export const usedKeys = (candidate: Pick<CodeCandidate, "key" | "code">) => [
  candidate.key,
  `digits:${candidate.code}`,
];

/**
 * Automatic only when certain: the one distinct unused code, sent after the request Scient saw, by
 * a sender this site accepted before, mailed to this login, with no rival sign-in on the site.
 * Texts are always one click; mail to another address is never offered.
 */
export function chooseCode(
  candidates: ReadonlyArray<CodeCandidate>,
  context: {
    readonly used: ReadonlySet<string>;
    readonly alone: boolean;
    /** When the submit that asked for the code went; undefined when Scient didn't see one. */
    readonly requestedAt: number | undefined;
    /** Senders whose codes this site accepted. */
    readonly confirmed: ReadonlySet<string>;
  },
) {
  // Mail to another known address is another login's code, whichever copy of it was read.
  const elsewhere = new Set(
    candidates.filter(({ toAccount }) => toAccount === false).map(({ code }) => code),
  );
  const fresh = candidates.filter(
    (candidate) =>
      !elsewhere.has(candidate.code) && !usedKeys(candidate).some((key) => context.used.has(key)),
  );
  // A code mirrored to Messages and Mail, or sent twice, is still one code.
  const offered = fresh.filter(
    (candidate, index) => fresh.findIndex(({ code }) => code === candidate.code) === index,
  );
  const only = offered.length === 1 ? offered[0] : undefined;
  const { requestedAt } = context;
  const certain = (candidate: CodeCandidate) =>
    // Named only by a sender other services share: the person taps it.
    candidate.named === undefined &&
    requestedAt !== undefined &&
    candidate.at > requestedAt &&
    context.confirmed.has(candidate.sender) &&
    // Bound to this login: a text names no recipient, so two logins sharing its sender can't tell.
    candidate.toAccount === true;
  const automatic =
    only !== undefined &&
    context.alone &&
    fresh.some((candidate) => candidate.code === only.code && certain(candidate))
      ? fresh.find((candidate) => candidate.code === only.code && certain(candidate))
      : undefined;
  return { automatic, offered };
}

/**
 * The codes for this login: those that name its service, as `chooseCode` picks them; when none
 * does, a single fresh code from anyone is offered for the person's tap, and never typed.
 */
export function chooseCodeFor(
  candidates: ReadonlyArray<CodeCandidate>,
  context: Parameters<typeof chooseCode>[1],
) {
  const named = candidates.filter((candidate) => candidate.named !== false);
  if (named.length) return chooseCode(named, context);
  const { offered } = chooseCode(candidates, context);
  return { automatic: undefined, offered: offered.length === 1 ? offered : [] };
}
