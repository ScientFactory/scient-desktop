import {
  ThreadId,
  type AccountId,
  type AccountSummary,
  type AccountTarget,
  type EnvironmentId,
  type PaperAsked,
  type PaperItem,
  type PaperRequest,
  type ProjectId,
} from "@t3tools/contracts";
import { publisherOf, universitiesOf, universityDetails } from "@t3tools/shared/scientPaperLinks";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Semaphore from "effect/Semaphore";
import { AccountsService, type AccountSessionScope } from "../accounts/AccountsService.ts";
import { defaultPaperProfile, fetchFromPage, type FetchResult } from "./paperFetch.ts";
import {
  articleAddress,
  lookUpPaper,
  openAccessPdf,
  type Paper,
  type PaperVersion,
} from "./paperLookup.ts";
import { buttonSteps, routeSteps, type RouteStep, type WorkedRoute } from "./paperRoutes.ts";
import { pdfVerdict, readPdfFacts } from "./pdfCheck.ts";
import { readResearchKeys } from "../sources/researchKeys.ts";

/** Longest one route of one paper may take, so a stalled publisher can't hold up the rest. */
const ROUTE_DEADLINE = "90 seconds";
/** Publishers read rapid downloads as misuse, sometimes of a whole university. */
const PUBLISHER_PAUSE_MS = { min: 10_000, max: 20_000 };
const MOST_TABS = 3;
/** Free copies and lookups at once; a list can hold thousands. */
const MOST_LOOKUPS = 4;
/** Refusals in a row at a publisher before Scient backs off, doubling from the first pause. */
const REFUSALS_BEFORE_PAUSE = 3;
const FIRST_REFUSAL_PAUSE_MS = 15 * 60 * 1000;
const LONGEST_REFUSAL_PAUSE_MS = 4 * 60 * 60 * 1000;
/** How long a publisher stays known not to recognise this network. */
const DIRECT_FAILURE_MEMORY_MS = 60 * 60 * 1000;

/** How often a paper's success refreshes a university's "last seen". */
const LAST_SEEN_GAP_MS = 60 * 60 * 1000;

/**
 * Who asked for a paper. What it may use is decided as each attempt starts, never stored: a
 * change in Settings or an approval applies to papers already waiting.
 */
export interface PaperRequester {
  readonly environmentId: EnvironmentId;
  /** The conversation that asked, when an agent did; the user's own request has none. */
  readonly threadId?: ThreadId;
  readonly projectId?: ProjectId;
  /** False for an agent the user keeps out of the browser: free copies only. */
  readonly browser: boolean;
}

export type Needed = Omit<PaperRequest, "count">;

export type PaperOutcome =
  | {
      readonly state: "saved";
      readonly paper: Paper;
      readonly bytes?: Uint8Array;
      readonly path?: string;
      readonly route: NonNullable<PaperItem["route"]>;
      readonly published: boolean;
      readonly version: PaperVersion;
    }
  | { readonly state: "not-found" | "no-access"; readonly message: string; readonly paper?: Paper }
  | {
      readonly state: "needs-you";
      readonly message: string;
      readonly needed: Needed;
      readonly paper: Paper;
    };

interface Lane {
  readonly permit: Semaphore.Semaphore;
  lastFetch: number;
  refusals: number;
  pausedUntil: number;
  directFailedAt: number;
  /** A check a person has to pass, per browser profile: each profile keeps its own cookies. */
  readonly checks: Map<string, Needed>;
  worked: WorkedRoute | undefined;
}
const lanes = new Map<string, Lane>();
export const laneFor = (site: string) => {
  const known = lanes.get(site);
  if (known) return known;
  const lane: Lane = {
    permit: Semaphore.makeUnsafe(1),
    lastFetch: 0,
    refusals: 0,
    pausedUntil: 0,
    directFailedAt: 0,
    checks: new Map(),
    worked: undefined,
  };
  lanes.set(site, lane);
  return lane;
};
const tabs = Semaphore.makeUnsafe(MOST_TABS);
const lookups = Semaphore.makeUnsafe(MOST_LOOKUPS);
/** One sign-in serves every paper, so the first to find it missing stops the others asking. */
const signInHolds = new Map<AccountId, Needed>();

/** Publishers backing off at the moment, for whoever is watching the queue. */
export const pausedPublishers = (now: number) =>
  [...lanes].flatMap(([site, lane]) =>
    lane.pausedUntil > now ? [{ site, until: lane.pausedUntil }] : [],
  );

/** The user acted, so what waited on them may try again; a sign-in releases its account only. */
export const clearHolds = (signedIn?: AccountId) => {
  if (signedIn !== undefined) {
    signInHolds.delete(signedIn);
    return;
  }
  signInHolds.clear();
  for (const lane of lanes.values()) lane.checks.clear();
};

export const PAPERS_THREAD = ThreadId.make("scient-paper-get");

/** The conversation an attempt acts for; no one is there to answer a card. */
const scopeOf = (requester: PaperRequester): AccountSessionScope => ({
  threadId: requester.threadId ?? PAPERS_THREAD,
  projectId: requester.projectId,
  unattended: true,
});

/** How long one decision is reused, so a long list doesn't fill Activity; Settings apply within it. */
const DECISION_REUSE_MS = 60_000;
const decisions = new Map<string, { readonly allowed: boolean; readonly at: number }>();

/**
 * Whether this request may use an account or a browser profile now. The user's own may use any;
 * an agent's, what its conversation may use without asking, approvals it was given included.
 */
const mayUse = Effect.fn("Papers.mayUse")(function* (
  requester: PaperRequester,
  target: AccountTarget,
  action: "sign-in" | "open-profile",
) {
  if (requester.threadId === undefined) return true;
  const id = target.type === "account" ? target.accountId : target.profileId;
  const key = [requester.threadId, requester.projectId, target.type, id, action].join("|");
  const now = yield* Clock.currentTimeMillis;
  const known = decisions.get(key);
  if (known && now - known.at < DECISION_REUSE_MS) return known.allowed;
  const accounts = yield* AccountsService;
  const allowed = yield* accounts.authorize(scopeOf(requester), target, action).pipe(
    Effect.map(({ decision }) => decision === "allowed"),
    Effect.orElseSucceed(() => false),
  );
  decisions.set(key, { allowed, at: now });
  return allowed;
});

/** One page at a time per publisher, at a reader's pace; publishers run side by side. */
const inLane = Effect.fn("Papers.inLane")(function* <A, E, R>(
  lane: Lane,
  work: Effect.Effect<A, E, R>,
) {
  const turn = Effect.gen(function* () {
    const pause = yield* Random.nextBetween(PUBLISHER_PAUSE_MS.min, PUBLISHER_PAUSE_MS.max);
    const now = yield* Clock.currentTimeMillis;
    const wait = Math.max(lane.lastFetch + pause, lane.pausedUntil) - now;
    if (wait > 0) yield* Effect.sleep(wait);
    return yield* work.pipe(
      tabs.withPermits(1),
      Effect.ensuring(
        Clock.currentTimeMillis.pipe(
          Effect.map((done) => {
            lane.lastFetch = done;
          }),
        ),
      ),
    );
  });
  return yield* turn.pipe(lane.permit.withPermits(1));
});

export const noteRefusal = (lane: Lane, now: number) => {
  lane.refusals += 1;
  const over = lane.refusals - REFUSALS_BEFORE_PAUSE;
  if (over >= 0)
    lane.pausedUntil = now + Math.min(FIRST_REFUSAL_PAUSE_MS * 2 ** over, LONGEST_REFUSAL_PAUSE_MS);
};

const firstPdf = Effect.fn("Papers.firstPdf")(function* (copies: Paper["openAccess"]) {
  for (const copy of copies) {
    const bytes = yield* openAccessPdf(copy);
    if (bytes) return { bytes, version: copy.version };
  }
  return undefined;
});

const isThePaper = (paper: Paper, bytes: Uint8Array) =>
  readPdfFacts(bytes).pipe(
    Effect.map((facts) => facts === undefined || pdfVerdict(paper, facts) === "the-paper"),
  );

interface Reached extends Omit<RouteStep, "url"> {
  readonly result: Exclude<FetchResult, { status: "saved" }>;
}

const profileOf = (account: AccountSummary | undefined) =>
  account && universityDetails(account.details)?.profileId;

/** A paper is real evidence of the session, so it keeps the account's status honest. */
const noteSession = Effect.fn("Papers.noteSession")(function* (
  account: AccountSummary | undefined,
  state: "signed-in" | "signed-out",
) {
  if (!account) return;
  const last = account.signIn;
  const age = (yield* Clock.currentTimeMillis) - (last ? Date.parse(last.at) : 0);
  if (last?.state === state && (state === "signed-out" || age < LAST_SEEN_GAP_MS)) return;
  const accounts = yield* AccountsService;
  yield* accounts.recordCheck(account.accountId, { state }).pipe(Effect.ignore);
});

/** Every route this request may use now, in the order most likely to work. */
const tryRoutes = Effect.fn("Papers.tryRoutes")(function* (
  paper: Paper,
  requester: PaperRequester,
) {
  const accounts = yield* AccountsService;
  const { accounts: known } = yield* accounts.snapshot;
  const connected = universitiesOf(known);
  const article = paper.articleUrl ?? paper.landingUrl;
  const site = publisherOf(article);
  const lane = laneFor(site);
  const fallback = yield* defaultPaperProfile;
  const profileFor = (account: AccountSummary) => profileOf(account) ?? fallback;
  const opens = (profileId: string) =>
    mayUse(requester, { type: "profile", profileId }, "open-profile");
  const usable = new Map<AccountId, boolean>();
  const through = Effect.fn("Papers.through")(function* (account: AccountSummary) {
    const decided = usable.get(account.accountId);
    if (decided !== undefined) return decided;
    const allowed =
      (yield* mayUse(requester, { type: "account", accountId: account.accountId }, "sign-in")) &&
      (yield* opens(profileFor(account)));
    usable.set(account.accountId, allowed);
    return allowed;
  });
  // A campus session lives in a university's profile: the publisher opens in the first one allowed.
  let publisherProfile: Option.Option<string | undefined> = Option.none();
  const forPublisher = Effect.gen(function* () {
    if (Option.isSome(publisherProfile)) return publisherProfile.value;
    let chosen: string | undefined;
    for (const account of connected)
      if (yield* opens(profileFor(account))) {
        chosen = profileFor(account);
        break;
      }
    if (chosen === undefined && (yield* opens(fallback))) chosen = fallback;
    publisherProfile = Option.some(chosen);
    return chosen;
  });
  const holdOn = (step: RouteStep, profileId: string) =>
    (step.account && signInHolds.get(step.account.accountId)) ?? lane.checks.get(profileId);
  const steps = [...routeSteps(paper, connected, lane.worked)];
  const missed: Reached[] = [];
  let checked: Needed | undefined;
  for (const step of steps) {
    const now = yield* Clock.currentTimeMillis;
    const skipDirect =
      step.route === "publisher" &&
      steps.length > 1 &&
      now - lane.directFailedAt < DIRECT_FAILURE_MEMORY_MS;
    if (skipDirect) continue;
    if (step.account && !(yield* through(step.account))) continue;
    const profileId = step.account ? profileFor(step.account) : yield* forPublisher;
    if (profileId === undefined) continue;
    const heldBefore = holdOn(step, profileId);
    if (heldBefore) {
      if (heldBefore.kind === "check") checked = heldBefore;
      continue;
    }
    // Checked again on its turn: another paper may have met a sign-in or a check meanwhile.
    const turn = yield* inLane(
      lane,
      Effect.gen(function* () {
        const held = holdOn(step, profileId);
        if (held) return { held } as const;
        const fetched = yield* fetchFromPage({
          url: step.url,
          profileId,
          caller: { kind: "paper", scope: scopeOf(requester), requester },
          accept: (bytes) => isThePaper(paper, bytes),
        }).pipe(Effect.timeoutOption(ROUTE_DEADLINE));
        return { fetched } as const;
      }),
    );
    if ("held" in turn) {
      if (turn.held.kind === "check") checked = turn.held;
      continue;
    }
    const result: FetchResult = Option.isSome(turn.fetched)
      ? turn.fetched.value
      : {
          status: "no-access",
          reason: "timed-out",
          message: `${site} took too long to answer.`,
          openUrl: step.url,
          profileId,
        };
    yield* Effect.logInfo("paper route", {
      publisher: site,
      route: step.route,
      status: result.status,
      ...(result.status === "saved" ? {} : { reason: result.reason }),
    });
    if (step.account && requester.threadId !== undefined)
      yield* accounts.recordUse({
        target: { type: "account", accountId: step.account.accountId },
        action: "sign-in",
        threadId: requester.threadId,
        ...(requester.projectId === undefined ? {} : { projectId: requester.projectId }),
        outcome: result.status === "saved" ? "ok" : "error",
      });
    if (result.status === "saved") {
      lane.refusals = 0;
      if (step.route === "publisher") lane.directFailedAt = 0;
      lane.worked = { route: step.route, accountId: step.account?.accountId };
      yield* noteSession(step.account, "signed-in");
      return { saved: result, route: step.route };
    }
    if (result.reason === "timed-out") {
      missed.push({ ...step, result });
      continue;
    }
    if (result.reason === "sign-in") yield* noteSession(step.account, "signed-out");
    // A journal no rule knows still shows its own way in, and the university goes next.
    if (result.institutionUrl)
      steps.push(...buttonSteps(result.institutionUrl, article, connected, steps));
    if (result.reason === "refused") noteRefusal(lane, yield* Clock.currentTimeMillis);
    else if (step.route === "publisher" && result.reason !== "bot-check")
      lane.directFailedAt = yield* Clock.currentTimeMillis;
    const signedInTo = known.find((account) => account.accountId === result.signInAccountId);
    missed.push({
      ...step,
      ...(step.account || !signedInTo ? {} : { account: signedInTo }),
      result,
    });
  }
  return {
    saved: undefined,
    route: undefined,
    tried: {
      missed,
      universities: connected.filter(({ accountId }) => usable.get(accountId) === true),
      withheld: connected.filter(({ accountId }) => usable.get(accountId) === false),
      checked,
      site,
      lane,
    } satisfies Tried,
  };
});

interface Tried {
  readonly missed: ReadonlyArray<Reached>;
  /** The universities this request could go through. */
  readonly universities: ReadonlyArray<AccountSummary>;
  /** Connected universities this conversation may not use now. */
  readonly withheld: ReadonlyArray<AccountSummary>;
  /** A check another paper met at this publisher, in the profile this one would use. */
  readonly checked: Needed | undefined;
  readonly site: string;
  readonly lane: Lane;
}

/** What the person is asked; it tells an agent the paper goes on by itself. */
const waitsFor = (paper: Paper, needed: Needed, why: string) =>
  ({
    state: "needs-you",
    paper,
    needed,
    message: `${why} The paper goes on by itself once they do: tell them, and don't fetch it in the browser yourself.`,
  }) as const;

/** Why no route reached the paper, as the one thing that could change that. */
export const nextMove = (
  paper: Paper,
  { missed, universities, withheld, checked, site, lane }: Tried,
): Exclude<PaperOutcome, { state: "saved" }> => {
  const signIn = missed.find(({ account, result }) => account && result.reason === "sign-in");
  const held = universities.flatMap(({ accountId }) => signInHolds.get(accountId) ?? [])[0];
  if (signIn?.account || held) {
    const needed: Needed = held ?? {
      kind: "sign-in",
      site: signIn?.account?.name,
      accountId: signIn?.account?.accountId,
    };
    if (signIn?.account) signInHolds.set(signIn.account.accountId, needed);
    return waitsFor(paper, needed, `Waiting for the user to sign in to ${needed.site}.`);
  }
  const check = missed.find(({ result }) => result.reason === "bot-check");
  const needed: Needed | undefined = check
    ? { kind: "check", site, openUrl: check.result.openUrl, profileId: check.result.profileId }
    : checked;
  if (needed) {
    if (check) lane.checks.set(check.result.profileId, needed);
    return waitsFor(paper, needed, `${site} wants a person to pass its check once.`);
  }
  if (missed.length > 0 && missed.every(({ result }) => result.reason === "timed-out"))
    return {
      state: "no-access",
      paper,
      message: `${site} took too long to answer. Try this paper again later.`,
    };
  if (universities.length === 0) {
    const kept = withheld[0];
    return kept
      ? waitsFor(
          paper,
          { kind: "access", site: kept.name, accountId: kept.accountId },
          `No free copy. ${kept.name} is connected, but this conversation may not use it; the user can allow it in Settings → Accounts & secrets.`,
        )
      : waitsFor(
          paper,
          { kind: "university" },
          "No free copy. Waiting for the user to connect their university.",
        );
  }
  const reached = missed.find(({ account, result }) => account && result.reason !== "timed-out");
  return {
    state: "no-access" as const,
    paper,
    message: reached?.account
      ? `${reached.account.name} doesn't seem to subscribe to this journal.`
      : (missed[0]?.result.message ?? `${site} gave no PDF for this paper.`),
  };
};

/**
 * A paper's PDF: a copy already in the project, the published free copy, the routes through the
 * user's access, then any other free copy (an accepted manuscript or preprint).
 */
export const fetchOnePaper = Effect.fn("Papers.fetchOne")(function* (
  asked: PaperAsked,
  requester: PaperRequester,
  savedBefore: (
    paper: Paper,
  ) => Effect.Effect<{ readonly path: string; readonly version: PaperVersion } | undefined>,
) {
  const found = yield* Effect.gen(function* () {
    const paper = yield* lookUpPaper(asked, yield* readResearchKeys());
    if (!paper?.doi || asked.url) return paper;
    const articleUrl = yield* articleAddress(paper.doi);
    return articleUrl ? { ...paper, articleUrl } : paper;
  }).pipe(lookups.withPermits(1));
  if (!found?.landingUrl)
    return {
      state: "not-found" as const,
      message: "This paper has no DOI or link to find it by.",
    } satisfies PaperOutcome;
  const paper: Paper = found;
  const before = yield* savedBefore(paper);
  if (before)
    return {
      state: "saved" as const,
      paper,
      path: before.path,
      route: "saved-before" as const,
      published: before.version === "published",
      version: before.version,
    } satisfies PaperOutcome;
  const free = yield* firstPdf(
    paper.openAccess.filter((copy) => copy.version === "published"),
  ).pipe(lookups.withPermits(1));
  if (free)
    return {
      state: "saved" as const,
      paper,
      bytes: free.bytes,
      route: "open-access" as const,
      published: true,
      version: "published",
    } satisfies PaperOutcome;
  const reached = requester.browser ? yield* tryRoutes(paper, requester) : undefined;
  if (reached?.saved)
    return {
      state: "saved" as const,
      paper,
      bytes: reached.saved.bytes,
      route: reached.route,
      published: true,
      version: "published",
    } satisfies PaperOutcome;
  const other = yield* firstPdf(
    paper.openAccess.filter((copy) => copy.version !== "published"),
  ).pipe(lookups.withPermits(1));
  if (other)
    return {
      state: "saved" as const,
      paper,
      bytes: other.bytes,
      route: "open-access" as const,
      published: false,
      version: other.version,
    } satisfies PaperOutcome;
  return reached
    ? nextMove(paper, reached.tried)
    : ({
        state: "no-access" as const,
        paper,
        message: "No free copy, and this conversation may not use the browser.",
      } satisfies PaperOutcome);
});
