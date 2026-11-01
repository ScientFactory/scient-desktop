import {
  AccountsError,
  ThreadId,
  type AccountPaperForSourceInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient } from "effect/http";
import { AgentInvocationContext } from "../operations/AgentInvocationContext.ts";
import { consumeAgentWorkspace } from "../operations/AgentWorkspaceScope.ts";
import { AccountsService, type AccountSessionScope } from "../accounts/AccountsService.ts";
import { userRunInvocation } from "../accounts/checkAccounts.ts";
import { attachSourcePdf } from "../sources/ScientSourcesCoordinator.ts";
import { withAccountUse } from "../accounts/agent/accountUse.ts";
import { accountSessionScope } from "../accounts/agent/scope.ts";
import { fetchThroughLibrary } from "./libraryFetch.ts";
import { lookUpPaper, openAccessPdf, paperFileName, type Paper } from "./paperLookup.ts";

/**
 * Libraries suspend access that looks like bulk downloading, so library fetches run one at a
 * time on this server, a short random pause apart, and at most this many a day.
 */
const LIBRARY_DAILY_LIMIT = 100;
const LIBRARY_PAUSE_MS = { min: 10_000, max: 20_000 };
const library = Semaphore.makeUnsafe(1);
const isAccountsError = Schema.is(AccountsError);
const GET_PDF_THREAD = ThreadId.make("scient-paper-get");
const userRunScope: AccountSessionScope = {
  threadId: GET_PDF_THREAD,
  projectId: undefined,
  unattended: true,
};
let lastLibraryFetch = 0;
const fetchesByDay = new Map<string, number>();

const savePdf = Effect.fn("Papers.save")(
  function* (root: string, paper: Paper, bytes: Uint8Array) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = path.join(root, "papers");
    yield* fs.makeDirectory(folder, { recursive: true });
    const name = paperFileName(paper);
    for (let copy = 1; ; copy += 1) {
      const file = copy === 1 ? name : name.replace(/\.pdf$/u, `-${copy}.pdf`);
      const target = path.join(folder, file);
      // Exclusive, so two saves of different papers can't take the same name.
      const created = yield* fs.writeFile(target, bytes, { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
      );
      if (created) return `papers/${file}`;
      // The same paper again reuses its file.
      if (Buffer.from(yield* fs.readFile(target)).equals(Buffer.from(bytes)))
        return `papers/${file}`;
    }
  },
  Effect.mapError((error) =>
    isAccountsError(error)
      ? error
      : new AccountsError({
          reason: "unavailable",
          message: "The PDF could not be saved in the project.",
        }),
  ),
);

const firstPdf = Effect.fn("Papers.firstPdf")(function* (copies: Paper["openAccess"]) {
  for (const copy of copies) {
    const bytes = yield* openAccessPdf(copy);
    if (bytes) return bytes;
  }
  return undefined;
});

/**
 * A paper's PDF by DOI or link: the published free copy, then the user's library
 * access in the browser, then any other free copy (an accepted manuscript or preprint).
 * `userRun` is the user's own request, which agent access doesn't govern.
 */
const fetchPaper = Effect.fn("Papers.fetch")(function* (
  input: { readonly doi?: string | undefined; readonly url?: string | undefined },
  scope: AccountSessionScope,
  userRun: boolean,
) {
  const paper = yield* lookUpPaper(input);
  if (!paper?.landingUrl)
    return {
      status: "not-found" as const,
      message: userRun
        ? "This source has no DOI or link to find the paper by."
        : "Pass the paper's DOI or a link to it; find the DOI with a web search if you have only a citation.",
    };
  const found = (bytes: Uint8Array, route: "open-access" | "library", published: boolean) => ({
    status: "found" as const,
    paper,
    bytes,
    route,
    published,
  });
  const published = yield* firstPdf(paper.openAccess.filter((copy) => copy.published));
  if (published) return found(published, "open-access", true);

  const accounts = yield* AccountsService;
  const invocation = yield* AgentInvocationContext;
  const session = userRun
    ? { agentAccess: true, accounts: (yield* accounts.snapshot).accounts }
    : yield* accounts.forSession(scope);
  const account =
    session.agentAccess && invocation.capabilities.has("preview")
      ? session.accounts.find(
          (item) => item.details.kind === "library" && (userRun || item.controls.access !== "off"),
        )
      : undefined;
  let note:
    | {
        status: "needs-sign-in" | "no-access" | "limit";
        message: string;
        openUrl?: string;
        profileId?: string;
      }
    | undefined;
  if (account) {
    // The count, the pause and the fetch are one step, so parallel requests can't pass the cap.
    const fetch = Effect.gen(function* () {
      const day = DateTime.formatIsoDate(yield* DateTime.now);
      const used = fetchesByDay.get(day) ?? 0;
      if (used >= LIBRARY_DAILY_LIMIT)
        return {
          status: "limit" as const,
          message: `Today's ${LIBRARY_DAILY_LIMIT} library downloads are used, to keep the library's access safe. Try again tomorrow.`,
        };
      const pause = yield* Random.nextBetween(LIBRARY_PAUSE_MS.min, LIBRARY_PAUSE_MS.max);
      const wait = lastLibraryFetch + pause - (yield* Clock.currentTimeMillis);
      if (wait > 0) yield* Effect.sleep(wait);
      fetchesByDay.clear();
      fetchesByDay.set(day, used + 1);
      return yield* fetchThroughLibrary(scope, account, paper.landingUrl, userRun).pipe(
        Effect.ensuring(
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              lastLibraryFetch = now;
            }),
          ),
        ),
      );
    }).pipe(library.withPermits(1));
    // A refused library use still leaves any free copy to find.
    const result = yield* (
      userRun
        ? fetch
        : withAccountUse(
            scope,
            { type: "account", accountId: account.accountId },
            "sign-in",
            fetch,
            (done) => done?.status === "saved",
          )
    ).pipe(
      Effect.catchTags({
        AccountsError: (error) =>
          Effect.succeed({ status: "no-access" as const, message: error.message }),
      }),
    );
    if (result?.status === "saved") return found(result.bytes, "library", true);
    if (result) note = result;
  }
  const other = yield* firstPdf(paper.openAccess.filter((copy) => !copy.published));
  if (other) return found(other, "open-access", false);
  return {
    ...(note ?? {
      status: "no-access" as const,
      message: account
        ? "No free copy, and the library did not reach the PDF."
        : "No free copy. Add your library in Settings ▸ Accounts & secrets to get it through your institution.",
    }),
    landingUrl: note?.openUrl ?? paper.landingUrl,
  };
});

export const getPaper = Effect.fn("Papers.get")(function* (input: {
  readonly doi?: string | undefined;
  readonly url?: string | undefined;
}) {
  const result = yield* fetchPaper(input, yield* accountSessionScope(), false);
  if (result.status !== "found") return result;
  const { paper, route, published } = result;
  const workspace = yield* consumeAgentWorkspace().pipe(
    Effect.mapError(
      (error) => new AccountsError({ reason: "unavailable", message: error.message }),
    ),
  );
  return {
    status: "saved" as const,
    path: yield* savePdf(workspace.binding.canonicalRoot, paper, result.bytes),
    route,
    published,
    ...(paper.title ? { title: paper.title } : {}),
    ...(paper.doi ? { doi: paper.doi } : {}),
  };
}, Effect.provide(FetchHttpClient.layer));

/** The user's Get PDF on a source: same routes as an agent's, saved and attached to the source. */
export const getPaperForSource = Effect.fn("Papers.getForSource")(
  function* (input: AccountPaperForSourceInput, _environmentId: EnvironmentId) {
    const { root, sourceId, expectedRevision, doi, url } = input;
    const result = yield* fetchPaper({ doi, url }, userRunScope, true);
    if (result.status !== "found") return result;
    const relative = yield* savePdf(root, result.paper, result.bytes);
    const path = yield* Path.Path;
    const attached = yield* Effect.tryPromise({
      try: () =>
        attachSourcePdf({
          root,
          sourceId,
          expectedRevision,
          pdfPath: path.join(root, relative),
          fileName: path.basename(relative),
        }),
      catch: () =>
        new AccountsError({
          reason: "unavailable",
          message: `The PDF is in ${relative}, but it could not be attached to this source.`,
        }),
    });
    return attached.outcome === "stale"
      ? {
          status: "no-access" as const,
          message: `The PDF is in ${relative}. This source changed meanwhile; attach it from there.`,
        }
      : { status: "attached" as const, published: result.published };
  },
  (effect, _input, environmentId: EnvironmentId) =>
    effect.pipe(
      Effect.provideService(
        AgentInvocationContext,
        userRunInvocation(GET_PDF_THREAD, environmentId),
      ),
      Effect.provide(FetchHttpClient.layer),
    ),
);
