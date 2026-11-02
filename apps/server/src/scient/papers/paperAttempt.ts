import {
  ThreadId,
  type AccountId,
  type AccountSummary,
  type EnvironmentId,
  type PaperAsked,
  type PaperItem,
  type PaperRequest,
} from "@t3tools/contracts";
import { publisherOf, universitiesOf, universityDetails } from "@t3tools/shared/scientPaperLinks";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Semaphore from "effect/Semaphore";
import { anySiteMatches } from "@t3tools/shared/scientSiteMatch";
import { AccountsService, type AccountSessionScope } from "../accounts/AccountsService.ts";
import { fetchFromPage, type FetchResult } from "./paperFetch.ts";
import { articleAddress, lookUpPaper, openAccessPdf, type Paper } from "./paperLookup.ts";
import { buttonSteps, routeSteps, type RouteStep, type WorkedRoute } from "./paperRoutes.ts";
import { pdfVerdict, readPdfFacts } from "./pdfCheck.ts";

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

export interface PaperRequester {
  readonly environmentId: EnvironmentId;
  /** The conversation that asked, when an agent did. */
  readonly threadId?: ThreadId;
  /** False for an agent the user keeps out of the browser: free copies only. */
  readonly browser: boolean;
  /** The saved sign-ins it may use: the user's own request may use all of them. */
  readonly accounts: "all" | ReadonlyArray<AccountId>;
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
  check: Needed | undefined;
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
    check: undefined,
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

/** The user acted, so anything waiting for them may try again. */
export const clearHolds = () => {
  signInHolds.clear();
  for (const lane of lanes.values()) lane.check = undefined;
};

const session = (threadId: ThreadId): AccountSessionScope => ({
  threadId,
  projectId: undefined,
  unattended: true,
});
export const PAPERS_THREAD = ThreadId.make("scient-paper-get");

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
    if (bytes) return bytes;
  }
  return undefined;
});

const isThePaper = (paper: Paper, bytes: Uint8Array) =>
  readPdfFacts(bytes).pipe(
    Effect.map((facts) => facts === undefined || pdfVerdict(paper, facts) === "the-paper"),
  );

const savedSignIn = (accounts: ReadonlyArray<AccountSummary>, url: string) =>
  accounts.find(
    ({ details, secrets }) =>
      details.kind === "website" &&
      secrets.password !== undefined &&
      anySiteMatches(details.sites, url),
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
  const last = account.lastCheck;
  const age = (yield* Clock.currentTimeMillis) - (last ? Date.parse(last.at) : 0);
  if (last?.state === state && (state === "signed-out" || age < LAST_SEEN_GAP_MS)) return;
  const accounts = yield* AccountsService;
  yield* accounts.recordCheck(account.accountId, { state }).pipe(Effect.ignore);
});

/** Every route the account allows, in the order most likely to work. */
const tryRoutes = Effect.fn("Papers.tryRoutes")(function* (
  paper: Paper,
  requester: PaperRequester,
) {
  const accounts = yield* AccountsService;
  const { accounts: known } = yield* accounts.snapshot;
  const allowed = requester.accounts;
  const saved =
    allowed === "all" ? known : known.filter((account) => allowed.includes(account.accountId));
  const universities = universitiesOf(saved);
  const article = paper.articleUrl ?? paper.landingUrl;
  const site = publisherOf(article);
  const lane = laneFor(site);
  const steps = [...routeSteps(paper, universities, lane.worked)];
  const missed: Reached[] = [];
  for (const step of steps) {
    const now = yield* Clock.currentTimeMillis;
    const skipDirect =
      step.route === "publisher" &&
      steps.length > 1 &&
      now - lane.directFailedAt < DIRECT_FAILURE_MEMORY_MS;
    if (skipDirect) continue;
    if (step.account && signInHolds.has(step.account.accountId)) continue;
    if (lane.check) continue;
    const profileId = profileOf(step.account ?? universities[0]);
    const attempt = yield* inLane(
      lane,
      fetchFromPage({
        session: session(requester.threadId ?? PAPERS_THREAD),
        url: step.url,
        profileId,
        signIn: (url) => savedSignIn(saved, url),
        accept: (bytes) => isThePaper(paper, bytes),
      }).pipe(Effect.timeoutOption(ROUTE_DEADLINE)),
    );
    if (Option.isNone(attempt)) {
      yield* Effect.logInfo("paper route timed out", { publisher: site, route: step.route });
      missed.push({
        ...step,
        result: {
          status: "no-access",
          reason: "timed-out",
          message: `${site} took too long to answer.`,
          openUrl: step.url,
          profileId: profileId ?? "",
        },
      });
      continue;
    }
    const result = attempt.value;
    yield* Effect.logInfo("paper route", {
      publisher: site,
      route: step.route,
      status: result.status,
      ...(result.status === "saved" ? {} : { reason: result.reason }),
    });
    if (result.status === "saved") {
      lane.refusals = 0;
      if (step.route === "publisher") lane.directFailedAt = 0;
      lane.worked = { route: step.route, accountId: step.account?.accountId };
      yield* noteSession(step.account, "signed-in");
      return { saved: result, route: step.route, missed, universities, site, lane };
    }
    if (result.reason === "sign-in") yield* noteSession(step.account, "signed-out");
    // A journal no rule knows still shows its own way in, and the university goes next.
    if (result.institutionUrl)
      steps.push(...buttonSteps(result.institutionUrl, article, universities, steps));
    if (result.reason === "refused") noteRefusal(lane, yield* Clock.currentTimeMillis);
    else if (step.route === "publisher" && result.reason !== "bot-check")
      lane.directFailedAt = yield* Clock.currentTimeMillis;
    missed.push({ ...step, result });
  }
  return { saved: undefined, route: undefined, missed, universities, site, lane };
});

interface Tried {
  readonly missed: ReadonlyArray<Reached>;
  readonly universities: ReadonlyArray<AccountSummary>;
  readonly site: string;
  readonly lane: Lane;
}

/** Why no route reached the paper, as the one thing that could change that. */
export const nextMove = (
  paper: Paper,
  { missed, universities, site, lane }: Tried,
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
    return {
      state: "needs-you",
      paper,
      needed,
      message: `Waiting for you to sign in to ${needed.site}.`,
    };
  }
  const check = missed.find(({ result }) => result.reason === "bot-check");
  if (check || lane.check) {
    const needed: Needed = lane.check ?? {
      kind: "check",
      site,
      openUrl: check?.result.openUrl,
      profileId: check?.result.profileId,
    };
    lane.check = needed;
    return {
      state: "needs-you",
      paper,
      needed,
      message: `${site} wants a person to pass its check once.`,
    };
  }
  if (missed.length > 0 && missed.every(({ result }) => result.reason === "timed-out"))
    return {
      state: "no-access",
      paper,
      message: `${site} took too long to answer. Try this paper again later.`,
    };
  if (universities.length === 0)
    return {
      state: "needs-you",
      paper,
      needed: { kind: "university" },
      message: "No free copy. Connect your university to get it through your library.",
    };
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
  savedBefore: (paper: Paper) => Effect.Effect<string | undefined>,
) {
  const found = yield* Effect.gen(function* () {
    const paper = yield* lookUpPaper(asked);
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
  const path = yield* savedBefore(paper);
  if (path)
    return {
      state: "saved" as const,
      paper,
      path,
      route: "saved-before" as const,
      published: true,
    } satisfies PaperOutcome;
  const free = yield* firstPdf(paper.openAccess.filter((copy) => copy.published)).pipe(
    lookups.withPermits(1),
  );
  if (free)
    return {
      state: "saved" as const,
      paper,
      bytes: free,
      route: "open-access" as const,
      published: true,
    } satisfies PaperOutcome;
  const reached = requester.browser ? yield* tryRoutes(paper, requester) : undefined;
  if (reached?.saved)
    return {
      state: "saved" as const,
      paper,
      bytes: reached.saved.bytes,
      route: reached.route,
      published: true,
    } satisfies PaperOutcome;
  const other = yield* firstPdf(paper.openAccess.filter((copy) => !copy.published)).pipe(
    lookups.withPermits(1),
  );
  if (other)
    return {
      state: "saved" as const,
      paper,
      bytes: other,
      route: "open-access" as const,
      published: false,
    } satisfies PaperOutcome;
  return reached
    ? nextMove(paper, reached)
    : ({
        state: "no-access" as const,
        paper,
        message: "No free copy, and this conversation may not use the browser.",
      } satisfies PaperOutcome);
});
