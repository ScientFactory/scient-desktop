import {
  AccountsError,
  type AccountSummary,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../operations/AgentInvocationContext.ts";
import { AccountsService, type AccountSessionScope } from "../accounts/AccountsService.ts";
import {
  authorizePreviewProfile,
  recordProfileUse,
} from "../accounts/agent/previewProfileAccess.ts";
import { matchesAccountOrigin } from "../accounts/signIn/origin.ts";
import { signIn } from "../accounts/signIn/engine.ts";
import { isPdf } from "./paperLookup.ts";

const MAX_STEPS = 5;
const DOWNLOAD_WAIT_MS = 60_000;

/** The page as the library route sees it: a PDF, a link to one, or a sign-in form. */
const Page = Schema.Struct({
  url: Schema.String,
  pdf: Schema.Boolean,
  pdfUrl: Schema.NullOr(Schema.String),
  login: Schema.Boolean,
});
const decodePage = Schema.decodeUnknownOption(Page);
const pageScript = `(() => {
  const pdf = document.contentType === "application/pdf";
  const meta = document.querySelector('meta[name="citation_pdf_url"]')?.getAttribute("content");
  const link = [...document.querySelectorAll("a[href]")].find((a) =>
    /\\.pdf(?:[?#]|$)|\\/pdf(?:[/?#]|$)/i.test(a.href) && /pdf/i.test(a.textContent || a.href),
  )?.href;
  return {
    url: location.href,
    pdf,
    pdfUrl: pdf ? location.href : meta ? new URL(meta, location.href).href : (link ?? null),
    login: !!document.querySelector('input[type="password"]'),
  };
})()`;
// Fetches the PDF inside the page, so the site's own session applies, then saves it as a download.
const downloadScript = `(async () => {
  const response = await fetch(location.href, { credentials: "include" });
  const blob = await response.blob();
  const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  if (String.fromCharCode(...head) !== "%PDF-") return false;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "paper.pdf";
  document.documentElement.append(link);
  link.click();
  link.remove();
  return true;
})()`;

export type LibraryResult =
  | { readonly status: "saved"; readonly bytes: Uint8Array }
  | {
      readonly status: "needs-sign-in" | "no-access";
      readonly message: string;
      readonly openUrl?: string;
    };

/**
 * Opens the article through the library's link in the library's browser profile, signs in with
 * the library account when its page asks, then saves the PDF the session can reach.
 */
export const fetchThroughLibrary = Effect.fn("Papers.library")(function* (
  session: AccountSessionScope,
  library: AccountSummary,
  landingUrl: string,
) {
  if (library.details.kind !== "library") return undefined;
  const details = library.details;
  const invocation = yield* AgentInvocationContext;
  const broker = yield* PreviewAutomationBroker;
  const accounts = yield* AccountsService;
  const fs = yield* FileSystem.FileSystem;
  const invoke = <A>(
    operation: Parameters<typeof broker.invoke>[0]["operation"],
    input: unknown,
    tabId?: PreviewTabId,
  ) =>
    broker
      .invoke<A>({ scope: invocation, operation, input, ...(tabId === undefined ? {} : { tabId }) })
      .pipe(
        Effect.mapError(
          () =>
            new AccountsError({
              reason: "unavailable",
              message: "The library page could not be opened.",
            }),
        ),
      );
  const status = yield* invoke<PreviewAutomationStatus>("status", {});
  const open = {
    url: details.proxyUrl.replace("{url}", encodeURIComponent(landingUrl)),
    ...(details.profileId === undefined ? {} : { profileId: details.profileId }),
    reuseExistingTab: false,
    open: false,
  };
  const profile = yield* authorizePreviewProfile(session, status, open);
  const opened = yield* recordProfileUse(
    session,
    profile.profileId,
    invoke<PreviewAutomationStatus>("open", { ...open, profileId: profile.profileId }),
  );
  const tab = opened.tabId;
  if (!tab) return { status: "no-access" as const, message: "No browser tab is available." };
  const known = new Set((opened.downloads ?? []).map((item) => item.path));
  const newDownload = Effect.fn("Papers.library.download")(function* (waitMs: number) {
    const deadline = (yield* Clock.currentTimeMillis) + waitMs;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const current = yield* invoke<PreviewAutomationStatus>("status", {}, tab);
      const fresh = current.downloads?.find((item) => !known.has(item.path));
      if (fresh) return fresh.path;
      yield* Effect.sleep("1 second");
    }
    return undefined;
  });
  const savedPdf = Effect.fn("Papers.library.read")(function* (path: string | undefined) {
    if (path === undefined) return undefined;
    const bytes = yield* fs.readFile(path).pipe(Effect.orElseSucceed(() => undefined));
    return bytes && isPdf(bytes) ? bytes : undefined;
  });

  const run = Effect.gen(function* () {
    let signedIn = false;
    for (let step = 0; step < MAX_STEPS; step += 1) {
      yield* invoke("accountWaitForLoad", { settleMs: 2000 }, tab);
      const page = decodePage(yield* invoke<unknown>("evaluate", { expression: pageScript }, tab));
      if (page._tag === "None") break;
      const { url, pdf, pdfUrl, login } = page.value;
      const libraryPage = matchesAccountOrigin(url, details.sites);
      // A sign-in page without a password field (a code sent to the phone, a CAPTCHA) is the
      // user's to complete; Scient never starts one.
      if ((libraryPage && !pdfUrl) || login) {
        if (signedIn || !login || !libraryPage)
          return {
            status: "needs-sign-in" as const,
            message: `The library asks to sign in on ${new URL(url).hostname}. Open the link in the same browser profile for the user to sign in once, then ask again.`,
            openUrl: open.url,
          };
        const values = yield* accounts.resolveSecrets(library.accountId, ["password", "totp"]);
        const result = yield* signIn(session, library, values, tab);
        if (result.outcome !== "signed-in")
          return {
            status: "needs-sign-in" as const,
            message: result.message ?? "The library sign-in did not finish.",
          };
        signedIn = true;
        continue;
      }
      if (pdf) {
        // A PDF the browser shows: copy it out of the page.
        const started = yield* invoke<unknown>("evaluate", { expression: downloadScript }, tab);
        const bytes =
          started === true ? yield* savedPdf(yield* newDownload(DOWNLOAD_WAIT_MS)) : undefined;
        if (bytes) return { status: "saved" as const, bytes };
        break;
      }
      if (!pdfUrl) break;
      // The PDF's own address; it either opens in the browser or arrives as a download.
      yield* invoke("navigate", { url: pdfUrl }, tab).pipe(Effect.ignore);
      const arrived = yield* savedPdf(yield* newDownload(5_000));
      if (arrived) return { status: "saved" as const, bytes: arrived };
    }
    return {
      status: "no-access" as const,
      message: "The library's access did not reach the PDF; the library may not subscribe.",
    };
  });
  return yield* run.pipe(Effect.ensuring(invoke("close", {}, tab).pipe(Effect.ignore)));
});
