import {
  AccountsError,
  type AccountPaperForSourceInput,
  type EnvironmentId,
  type PaperAsked,
  type PaperItemState,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/http";
import { AgentInvocationContext } from "../operations/AgentInvocationContext.ts";
import { consumeAgentWorkspace } from "../operations/AgentWorkspaceScope.ts";
import { readScientSourceRecord } from "@scientfactory/scient-sources/store";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { authorizationDecision } from "../accounts/AccountDecisions.ts";
import { AccountsService, type AccountSessionScope } from "../accounts/AccountsService.ts";
import { authorize } from "../accounts/agent/accountUse.ts";
import { authorizePreviewProfile } from "../accounts/agent/previewProfileAccess.ts";
import { accountSessionScope } from "../accounts/agent/scope.ts";
import { universitiesOf, universityDetails } from "@t3tools/shared/scientPaperLinks";
import {
  continuePapers,
  listPapers,
  paperQueueRunning,
  requestPapers,
  resumePapers,
  waitForPaper,
  waitingPaperRoots,
  type PaperRequester,
} from "./paperQueue.ts";

/** Long enough for a paper at a free publisher; a slower one stays queued and is reported later. */
const ONE_PAPER_WAIT = "150 seconds";

const unavailable = (message: string) => new AccountsError({ reason: "unavailable", message });

/**
 * An agent's request is decided here, once: its session's access to the browser profile and to
 * each saved sign-in. What it may use travels with its papers, which keep going after its turn.
 */
const agentRequester = Effect.fn("Papers.agentRequester")(function* () {
  const scope: AccountSessionScope = yield* accountSessionScope();
  const invocation = yield* AgentInvocationContext;
  const accounts = yield* AccountsService;
  const broker = yield* PreviewAutomationBroker;
  const session = yield* accounts.forSession(scope);
  const allowed = session.accounts.filter(
    (account) =>
      authorizationDecision(session.agentAccess, account.controls, scope).decision !== "denied",
  );
  const browserStatus =
    session.agentAccess && invocation.capabilities.has("preview")
      ? yield* broker
          .invoke<PreviewAutomationStatus>({ scope: invocation, operation: "status", input: {} })
          .pipe(Effect.option)
      : Option.none<PreviewAutomationStatus>();
  /** Reaching a page follows the browser profile; signing in follows the account. */
  const mayBrowse = (profileId: string | undefined) =>
    Option.isSome(browserStatus)
      ? authorizePreviewProfile(scope, browserStatus.value, {
          url: "https://doi.org/",
          reuseExistingTab: false,
          open: false,
          ...(profileId === undefined ? {} : { profileId }),
        }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
      : Effect.succeed(false);
  const universities = yield* Effect.filter(universitiesOf(allowed), (account) =>
    mayBrowse(universityDetails(account.details)?.profileId).pipe(
      Effect.flatMap((allowedHere) =>
        allowedHere
          ? authorize(scope, { type: "account", accountId: account.accountId }, "sign-in").pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            )
          : Effect.succeed(false),
      ),
    ),
  );
  for (const university of universities)
    yield* accounts.recordUse({
      target: { type: "account", accountId: university.accountId },
      action: "sign-in",
      threadId: scope.threadId,
      ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
      outcome: "ok",
    });
  const reachable = new Set(universities.map((account) => account.accountId));
  return {
    environmentId: invocation.environmentId,
    threadId: scope.threadId,
    browser: universities.length > 0 || (yield* mayBrowse(undefined)),
    accounts:
      universities.length > 0
        ? allowed
            .filter(
              ({ accountId, details }) => !universityDetails(details) || reachable.has(accountId),
            )
            .map((account) => account.accountId)
        : [],
  } satisfies PaperRequester;
});

const agentRoot = consumeAgentWorkspace().pipe(
  Effect.map((workspace) => workspace.binding.canonicalRoot),
  Effect.mapError((error) => unavailable(error.message)),
);

interface AgentPaperAsked {
  readonly doi?: string | undefined;
  readonly url?: string | undefined;
  readonly addToLibrary?: boolean | undefined;
  readonly sourceId?: string | undefined;
}

const NO_LIBRARY_ACCESS =
  "This conversation may not change the Library, so the PDF was only saved.";

/** An agent's paper as the queue takes it: Library work needs the Sources write grant. */
export const askedForLibrary = Effect.fn("Papers.askedForLibrary")(function* (
  root: string,
  input: AgentPaperAsked,
) {
  const { addToLibrary, sourceId, ...paper } = input;
  const wanted = addToLibrary === true || sourceId !== undefined;
  const invocation = yield* AgentInvocationContext;
  if (!wanted) return { asked: paper };
  if (!invocation.capabilities.has("sources:write"))
    return { asked: paper, note: NO_LIBRARY_ACCESS };
  if (sourceId === undefined) return { asked: { ...paper, library: true } };
  const record = yield* Effect.tryPromise({
    try: () => readScientSourceRecord(root, sourceId),
    catch: () => unavailable("The Library could not be read."),
  });
  return record
    ? {
        asked: {
          ...paper,
          source: { sourceId: record.sourceId, expectedRevision: record.revision },
        },
      }
    : { missing: `There is no source ${sourceId} in this project's Library.` };
});

/** One paper, waited for: it goes through the same queue as a list of them. */
export const getPaper = Effect.fn("Papers.get")(function* (input: AgentPaperAsked) {
  if (!input.doi && !input.url)
    return {
      status: "not-found" as const,
      message: "Pass the paper's DOI or a link to it; find the DOI with a web search if needed.",
    };
  const root = yield* agentRoot;
  const request = yield* askedForLibrary(root, input);
  if ("missing" in request) return { status: "not-found" as const, message: request.missing };
  const [item] = yield* requestPapers(root, [request.asked], yield* agentRequester());
  if (!item) return yield* unavailable("The paper could not be queued.");
  const done = yield* waitForPaper(root, item.itemId, ONE_PAPER_WAIT);
  if (done?.state === "saved" && done.path && done.route) {
    const message = request.note ?? done.message;
    return {
      status: "saved" as const,
      path: done.path,
      route: done.route,
      published: done.published ?? true,
      ...(done.version ? { version: done.version } : {}),
      ...(done.title ? { title: done.title } : {}),
      ...(done.doi ? { doi: done.doi } : {}),
      ...(done.sourceId ? { sourceId: done.sourceId } : {}),
      ...(message ? { message } : {}),
    };
  }
  return {
    status: done?.state === "saved" || !done ? ("waiting" as const) : done.state,
    message:
      done?.message ?? "Still in the queue. Carry on and read scient_papers_status for the result.",
  };
}, Effect.provide(FetchHttpClient.layer));

export const queuePapers = Effect.fn("Papers.queue")(function* (input: {
  readonly papers: ReadonlyArray<AgentPaperAsked>;
}) {
  const root = yield* agentRoot;
  const requests = yield* Effect.forEach(input.papers, (paper) => askedForLibrary(root, paper));
  const asked = requests.flatMap((request) => ("asked" in request ? [request.asked] : []));
  const notes = [
    ...new Set(
      requests.flatMap((request) =>
        "missing" in request ? [request.missing] : request.note ? [request.note] : [],
      ),
    ),
  ];
  const items = asked.length > 0 ? yield* requestPapers(root, asked, yield* agentRequester()) : [];
  return { queued: items.length, ...(notes.length > 0 ? { message: notes.join(" ") } : {}) };
}, Effect.provide(FetchHttpClient.layer));

export const paperStatus = Effect.fn("Papers.status")(function* (input: {
  readonly state?: PaperItemState | undefined;
  readonly offset?: number | undefined;
}) {
  const root = yield* agentRoot;
  const items = yield* listPapers(root);
  // A restart interrupted this list and nobody has opened Sources since.
  if (items.some((item) => item.state === "waiting") && !paperQueueRunning(root))
    yield* resumePapers(root, yield* agentRequester());
  const count = (state: PaperItemState) => items.filter((item) => item.state === state).length;
  const offset = input.offset ?? 0;
  const chosen = input.state ? items.filter((item) => item.state === input.state) : items;
  return {
    waiting: count("waiting"),
    saved: count("saved"),
    needsYou: count("needs-you"),
    notFound: count("not-found"),
    noAccess: count("no-access"),
    items: chosen.slice(offset, offset + 100).map(({ itemId: _, source: __, ...item }) => item),
    ...(chosen.length > offset + 100 ? { nextOffset: offset + 100 } : {}),
  };
}, Effect.provide(FetchHttpClient.layer));

const userRequester = (environmentId: EnvironmentId): PaperRequester => ({
  environmentId,
  browser: true,
  accounts: "all",
});

/** The user's Get PDF on a source: the same queue, saved and attached to the source. */
export const getPaperForSource = Effect.fn("Papers.getForSource")(function* (
  input: AccountPaperForSourceInput,
  environmentId: EnvironmentId,
) {
  const { root, sourceId, expectedRevision, doi, url } = input;
  const asked = {
    ...(doi ? { doi } : {}),
    ...(url ? { url } : {}),
    source: { sourceId, expectedRevision },
  };
  const [item] = yield* requestPapers(root, [asked], userRequester(environmentId));
  if (!item) return yield* unavailable("The paper could not be queued.");
  const done = yield* waitForPaper(root, item.itemId, ONE_PAPER_WAIT);
  if (done?.state === "saved")
    return { status: "attached" as const, published: done.published ?? true };
  return {
    status: done?.state ?? ("waiting" as const),
    message: done?.message ?? "Still fetching. It will appear on the source when it arrives.",
  };
}, Effect.provide(FetchHttpClient.layer));

export const requestPapersAsUser = (
  input: { readonly root: string; readonly papers: ReadonlyArray<PaperAsked> },
  environmentId: EnvironmentId,
) =>
  requestPapers(input.root, input.papers, userRequester(environmentId)).pipe(
    Effect.as({}),
    Effect.provide(FetchHttpClient.layer),
  );

export const listPapersAsUser = (root: string, environmentId: EnvironmentId) =>
  resumePapers(root, userRequester(environmentId)).pipe(Effect.provide(FetchHttpClient.layer));

export const continuePapersAsUser = (root: string, environmentId: EnvironmentId) =>
  continuePapers(root, userRequester(environmentId)).pipe(
    Effect.as({}),
    Effect.provide(FetchHttpClient.layer),
  );

/** A sign-in just finished, so every paper that waited for one goes again. */
export const continueWaitingPapers = (environmentId: EnvironmentId) =>
  Effect.forEach(
    waitingPaperRoots(),
    (root) => continuePapers(root, userRequester(environmentId)),
    { discard: true },
  ).pipe(Effect.ignore, Effect.provide(FetchHttpClient.layer));
