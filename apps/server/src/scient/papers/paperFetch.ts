import {
  DEFAULT_BROWSER_PROFILE_ID,
  AccountsError,
  type AccountId,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../operations/AgentInvocationContext.ts";
import { guardedSignIn, type SignInCaller } from "../accounts/agent/guardedSignIn.ts";
import { isPdf } from "./paperLookup.ts";
import { PaperPage, pageState, paperPageScript, pdfAddressFor } from "./paperPage.ts";

const MAX_STEPS = 6;
const DOWNLOAD_WAIT_MS = 60_000;
/** A file link either starts its download within this, or was a page after all. */
const NAVIGATED_DOWNLOAD_WAIT_MS = 15_000;
/** A bot check that passes by itself takes seconds; one still up after this wants a person. */
const BOT_CHECK_WAIT_MS = 20_000;
const SETTLE_MS = 2_000;

const decodePage = Schema.decodeUnknownOption(PaperPage);

/**
 * Fetches inside the page, so the site's own session applies, and saves the result as a download.
 * It answers at once: a browser call can't outlast a slow download, so the outcome is read later.
 */
const downloadScript = (url: string) => `(() => {
  window.__scientPaper = "working";
  (async () => {
    const response = await fetch(${JSON.stringify(url)}, {
      credentials: "include",
      signal: AbortSignal.timeout(${DOWNLOAD_WAIT_MS}),
    });
    const blob = await response.blob();
    const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
    if (String.fromCharCode(...head) !== "%PDF-") throw new Error("not a PDF");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "paper.pdf";
    document.documentElement.append(link);
    link.click();
    link.remove();
    window.__scientPaper = "saved";
  })().catch(() => { window.__scientPaper = "failed"; });
  return true;
})()`;

export type FetchResult =
  | { readonly status: "saved"; readonly bytes: Uint8Array }
  | {
      readonly status: "needs-sign-in" | "blocked" | "no-access";
      /** Why, so the next route or a person can act on it. */
      readonly reason:
        | "sign-in"
        | "bot-check"
        | "refused"
        | "paywall"
        | "institution"
        | "not-a-paper"
        | "timed-out"
        | "unclear";
      readonly message: string;
      readonly openUrl: string;
      /** The profile the page opened in, where a sign-in has to happen. */
      readonly profileId: string;
      /** The journal's "Access through your institution" button, when it showed one. */
      readonly institutionUrl?: string;
      /** The saved sign-in that didn't sign in here, for the person to sign in to. */
      readonly signInAccountId?: AccountId;
    };

export interface PageRequest {
  readonly url: string;
  /** Where the university's session lives; the default profile otherwise. */
  readonly profileId: string | undefined;
  /** Who the sign-in on a page that asks for one is for. */
  readonly caller: Extract<SignInCaller, { kind: "paper" }>;
  readonly accept: (bytes: Uint8Array) => Effect.Effect<boolean>;
}

/**
 * Opens a page in a hidden tab and follows it to the PDF. It tries the PDF first and reads the
 * page only to say why that failed, because a page's words describe the paper, not this reader's
 * access: publishers that show "Purchase access" still hand a recognised university the PDF.
 */
export const fetchFromPage = Effect.fn("Papers.fetchFromPage")(function* (request: PageRequest) {
  const { url, caller, accept } = request;
  const invocation = yield* AgentInvocationContext;
  const broker = yield* PreviewAutomationBroker;
  const fs = yield* FileSystem.FileSystem;
  const invoke = <A>(
    operation: Parameters<typeof broker.invoke>[0]["operation"],
    input: unknown,
    tabId?: PreviewTabId,
  ) =>
    broker
      .invoke<A>({
        scope: invocation,
        operation,
        input,
        updateCurrentTab: false,
        ...(tabId === undefined ? {} : { tabId }),
      })
      .pipe(
        Effect.mapError(
          () =>
            new AccountsError({ reason: "unavailable", message: "The page could not be opened." }),
        ),
      );
  const status = yield* invoke<PreviewAutomationStatus>("status", {});
  const open = { url, reuseExistingTab: false, open: false };
  const chosen = request.profileId ?? status.defaultProfileId ?? DEFAULT_BROWSER_PROFILE_ID;
  const opened = yield* invoke<PreviewAutomationStatus>("open", { ...open, profileId: chosen });
  const tab = opened.tabId;
  if (!tab) return yield* new AccountsError({ reason: "unavailable", message: "No browser tab." });
  const profileId = chosen;
  const known = new Set((opened.downloads ?? []).map((item) => item.path));

  const stopped = (
    outcome: "needs-sign-in" | "blocked" | "no-access",
    reason: Extract<FetchResult, { reason: unknown }>["reason"],
    message: string,
  ): FetchResult => ({
    status: outcome,
    reason,
    message,
    openUrl: url,
    profileId,
  });
  const read = invoke<unknown>("evaluate", { expression: paperPageScript }, tab).pipe(
    Effect.map(decodePage),
  );
  /** The page once any bot check has passed by itself, or the page still showing it. */
  const afterBotCheck = Effect.gen(function* () {
    const ends = (yield* Clock.currentTimeMillis) + BOT_CHECK_WAIT_MS;
    while (true) {
      const looked = yield* read;
      if (Option.isNone(looked)) return undefined;
      const now = yield* Clock.currentTimeMillis;
      if (pageState(looked.value).state !== "bot-check" || now >= ends) return looked.value;
      yield* Effect.sleep("2 seconds");
    }
  });
  /** The newest download's bytes, when it is the paper. */
  const arrived = Effect.fn("Papers.fetchFromPage.arrived")(function* (waitMs: number) {
    const deadline = (yield* Clock.currentTimeMillis) + waitMs;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const current = yield* invoke<PreviewAutomationStatus>("status", {}, tab);
      const fresh = current.downloads?.find((item) => !known.has(item.path));
      if (fresh) {
        known.add(fresh.path);
        const bytes = yield* fs.readFile(fresh.path).pipe(Effect.orElseSucceed(() => undefined));
        return bytes && isPdf(bytes) && (yield* accept(bytes)) ? bytes : undefined;
      }
      const inPage = yield* invoke<unknown>(
        "evaluate",
        { expression: "window.__scientPaper" },
        tab,
      ).pipe(Effect.orElseSucceed(() => undefined));
      if (inPage === "failed") return undefined;
      yield* Effect.sleep("1 second");
    }
    return undefined;
  });
  const copyInPage = Effect.fn("Papers.fetchFromPage.copy")(function* (address: string) {
    const started = yield* invoke<unknown>(
      "evaluate",
      { expression: downloadScript(address) },
      tab,
    );
    return started === true ? yield* arrived(DOWNLOAD_WAIT_MS) : undefined;
  });
  /** Same site: fetched in the page. Elsewhere, or if that fails: opened as a page of its own. */
  const tryAddress = Effect.fn("Papers.fetchFromPage.tryAddress")(function* (
    address: string,
    pageUrl: string,
  ) {
    if (URL.canParse(pageUrl) && new URL(address).origin === new URL(pageUrl).origin) {
      const bytes = yield* copyInPage(address).pipe(Effect.orElseSucceed(() => undefined));
      if (bytes) return bytes;
    }
    yield* invoke("navigate", { url: address }, tab).pipe(Effect.ignore);
    return yield* arrived(NAVIGATED_DOWNLOAD_WAIT_MS);
  });

  let kept = false;
  const run = Effect.gen(function* () {
    const tried = new Set<string>();
    let signedIn = false;
    for (let step = 0; step < MAX_STEPS; step += 1) {
      yield* invoke("accountWaitForLoad", { settleMs: SETTLE_MS }, tab);
      const page = yield* afterBotCheck;
      if (page === undefined) break;
      const state = pageState(page);
      switch (state.state) {
        case "pdf": {
          const bytes = yield* copyInPage(page.url).pipe(Effect.orElseSucceed(() => undefined));
          if (bytes) return { status: "saved" as const, bytes };
          return stopped("no-access", "not-a-paper", "The PDF on the page wasn't this paper.");
        }
        case "pdf-link": {
          // The link many publishers name opens their reader; this address is the file itself.
          const address = pdfAddressFor(state.url) ?? state.url;
          if (!tried.has(address)) {
            tried.add(address);
            const bytes = yield* tryAddress(address, page.url);
            if (bytes) return { status: "saved" as const, bytes };
            continue;
          }
          break;
        }
        case "bot-check":
          return stopped(
            "blocked",
            "bot-check",
            `${new URL(page.url).hostname} wants a person to pass its check.`,
          );
        case "sign-in": {
          const asks = `${new URL(page.url).hostname} asks for a sign-in.`;
          if (signedIn) return stopped("needs-sign-in", "sign-in", asks);
          const result = yield* guardedSignIn({
            page: { tabId: tab, url: page.url },
            profileId,
            signIn: { find: page.url },
            caller,
          });
          if (result.outcome === "none" || result.outcome === "choose")
            return stopped("needs-sign-in", "sign-in", asks);
          // A sign-in waiting at a second factor keeps this tab, for the person to finish there.
          if (result.pending) kept = true;
          if (result.outcome !== "signed-in")
            return {
              ...stopped(
                "needs-sign-in",
                "sign-in",
                result.message ?? "The sign-in did not finish.",
              ),
              ...(result.accountId ? { signInAccountId: result.accountId } : {}),
            };
          signedIn = true;
          continue;
        }
        case "refused":
          return stopped(
            "blocked",
            "refused",
            `${new URL(page.url).hostname} refused this request.`,
          );
        case "institution":
        case "paywall":
        case "unclear":
          break;
      }
      // Some pages don't show their PDF link to a script, though the publisher serves it.
      const guess = pdfAddressFor(page.url);
      if (guess && !tried.has(guess)) {
        tried.add(guess);
        const bytes = yield* tryAddress(guess, page.url);
        if (bytes) return { status: "saved" as const, bytes };
        continue;
      }
      return state.state === "institution"
        ? {
            ...stopped(
              "no-access",
              "institution",
              "The publisher asks which institution you're from.",
            ),
            institutionUrl: state.url,
          }
        : state.state === "paywall"
          ? stopped("no-access", "paywall", "The publisher offers it for sale here.")
          : stopped("no-access", "unclear", "The page has no PDF.");
    }
    return stopped("no-access", "unclear", "The page has no PDF.");
  });
  return yield* run.pipe(
    Effect.ensuring(
      Effect.suspend(() => (kept ? Effect.void : invoke("close", {}, tab).pipe(Effect.ignore))),
    ),
  );
});
