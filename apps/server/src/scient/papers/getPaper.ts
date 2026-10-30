import { AccountsError } from "@t3tools/contracts";
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
import { AccountsService } from "../accounts/AccountsService.ts";
import { withAccountUse } from "../accounts/agent/accountUse.ts";
import { accountSessionScope } from "../accounts/agent/scope.ts";
import { fetchThroughLibrary } from "./libraryFetch.ts";
import { downloadPdf, lookUpPaper, paperFileName, type Paper } from "./paperLookup.ts";

/**
 * Libraries suspend access that looks like bulk downloading, so library fetches run one at a
 * time on this server, a short random pause apart, and at most this many a day.
 */
const LIBRARY_DAILY_LIMIT = 100;
const LIBRARY_PAUSE_MS = { min: 10_000, max: 20_000 };
const library = Semaphore.makeUnsafe(1);
const isAccountsError = Schema.is(AccountsError);
let lastLibraryFetch = 0;
const fetchesByDay = new Map<string, number>();

const savePdf = Effect.fn("Papers.save")(
  function* (paper: Paper, bytes: Uint8Array) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = yield* consumeAgentWorkspace().pipe(
      Effect.mapError(
        (error) => new AccountsError({ reason: "unavailable", message: error.message }),
      ),
    );
    const folder = path.join(workspace.binding.canonicalRoot, "papers");
    yield* fs.makeDirectory(folder, { recursive: true });
    const name = paperFileName(paper);
    for (let copy = 1; ; copy += 1) {
      const file = copy === 1 ? name : name.replace(/\.pdf$/u, `-${copy}.pdf`);
      const target = path.join(folder, file);
      if (!(yield* fs.exists(target))) {
        yield* fs.writeFile(target, bytes);
        return `papers/${file}`;
      }
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
    const bytes = yield* downloadPdf(copy.pdfUrl);
    if (bytes) return bytes;
  }
  return undefined;
});

/**
 * A paper's PDF by DOI or link: the published free copy, then the user's library
 * access in the browser, then any other free copy (an accepted manuscript or preprint).
 */
export const getPaper = Effect.fn("Papers.get")(function* (input: {
  readonly doi?: string | undefined;
  readonly url?: string | undefined;
}) {
  const paper = yield* lookUpPaper(input);
  if (!paper?.landingUrl)
    return {
      status: "not-found" as const,
      message:
        "Pass the paper's DOI or a link to it; find the DOI with a web search if you have only a citation.",
    };
  const saved = (bytes: Uint8Array, route: "open-access" | "library", published: boolean) =>
    savePdf(paper, bytes).pipe(
      Effect.map((path) => ({
        status: "saved" as const,
        path,
        route,
        published,
        ...(paper.title ? { title: paper.title } : {}),
        ...(paper.doi ? { doi: paper.doi } : {}),
      })),
    );
  const published = yield* firstPdf(paper.openAccess.filter((copy) => copy.published));
  if (published) return yield* saved(published, "open-access", true);

  const scope = yield* accountSessionScope();
  const invocation = yield* AgentInvocationContext;
  const session = yield* (yield* AccountsService).forSession(scope);
  const account =
    session.agentAccess && invocation.capabilities.has("preview")
      ? session.accounts.find(
          (item) => item.details.kind === "library" && item.controls.access !== "off",
        )
      : undefined;
  let note:
    | { status: "needs-sign-in" | "no-access" | "limit"; message: string; openUrl?: string }
    | undefined;
  if (account) {
    const result = yield* withAccountUse(
      scope,
      { type: "account", accountId: account.accountId },
      "sign-in",
      // The count, the pause and the fetch are one step, so parallel requests can't pass the cap.
      Effect.gen(function* () {
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
        const fetched = yield* fetchThroughLibrary(scope, account, paper.landingUrl);
        lastLibraryFetch = yield* Clock.currentTimeMillis;
        return fetched;
      }).pipe(library.withPermits(1)),
    );
    if (result?.status === "saved") return yield* saved(result.bytes, "library", true);
    if (result) note = result;
  }
  const other = yield* firstPdf(paper.openAccess.filter((copy) => !copy.published));
  if (other) return yield* saved(other, "open-access", false);
  return {
    ...(note ?? {
      status: "no-access" as const,
      message: account
        ? "No free copy, and the library did not reach the PDF."
        : "No free copy. Add the user's library in Settings ▸ Accounts to get it through their institution.",
    }),
    landingUrl: note?.openUrl ?? paper.landingUrl,
  };
}, Effect.provide(FetchHttpClient.layer));
