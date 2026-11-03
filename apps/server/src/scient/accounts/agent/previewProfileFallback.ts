import {
  GOOGLE_SITE,
  type BrowserProfileId,
  type PreviewAutomationOpenInput,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { requireThreadMcpCapability } from "../../../mcp/McpInvocationContext.ts";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { scientInvocationForMcp } from "../../../mcp/ScientMcpInvocation.ts";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import { withAccountUse } from "./accountUse.ts";
import { previewInvoker } from "./broker.ts";
import { findProfiles } from "./findProfiles.ts";
import { classifyProfilePage, isAutomaticSignInPage } from "./profileClassification.ts";
import { ProfileDetection, profileDetectionScript } from "./profileDetection.ts";
import { profileOpenDecision } from "./profileOpenDecision.ts";
import { signInOnPage } from "./signInOnPage.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";

const decodeDetection = Schema.decodeUnknownEffect(ProfileDetection);

/** The profile's other Google accounts that Google still accepts, oldest first, at most three. */
const otherGoogleAccounts = Effect.fn("AccountsAgent.otherGoogleAccounts")(function* (
  scope: AccountSessionScope,
  url: string,
  profileId: BrowserProfileId,
) {
  const host = new URL(url).hostname;
  if (host !== GOOGLE_SITE && !host.endsWith(`.${GOOGLE_SITE}`)) return [];
  const session = yield* (yield* AccountsService).forSession(scope, [profileId]);
  return session.accounts
    .filter(
      ({ details, signIn }) =>
        details.kind === "website" &&
        details.profileId === profileId &&
        details.sites.includes(GOOGLE_SITE) &&
        details.username !== undefined &&
        signIn?.state === "signed-in",
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .flatMap(({ details }) =>
      details.kind === "website" && details.username ? [details.username] : [],
    )
    .slice(0, 3);
});

export const previewProfileFallback = Effect.fn("AccountsAgent.previewProfileFallback")(function* (
  scope: AccountSessionScope,
  status: PreviewAutomationStatus,
  options: {
    operation: "open" | "navigate";
    requestedUrl: string | undefined;
    input?: PreviewAutomationOpenInput;
    profileId?: BrowserProfileId;
    targetsExistingTab: boolean;
  },
) {
  const url = options.requestedUrl ?? status.url;
  const tabId = status.tabId;
  if (!tabId || !url || !URL.canParse(url) || new URL(url).protocol !== "https:") return status;
  return yield* Effect.gen(function* () {
    const invocation = scientInvocationForMcp(yield* requireThreadMcpCapability("preview"));
    const broker = yield* PreviewAutomationBroker;
    const invoke = previewInvoker(broker, invocation, { updateCurrentTab: false });
    yield* invoke("accountWaitForLoad", {}, tabId);
    const raw = yield* invoke<unknown>("evaluate", { expression: profileDetectionScript }, tabId);
    const page = yield* decodeDetection(raw);
    const result = classifyProfilePage(url, page);
    const decision = profileOpenDecision(result, {
      operation: options.operation,
      explicitProfile: options.input?.profileId !== undefined,
      targetsExistingTab: options.targetsExistingTab,
    });
    if (decision.action === "nothing") return status;
    const profileId =
      status.tabs?.find((tab) => tab.tabId === tabId)?.profileId ?? options.profileId;
    const profileName =
      status.profiles?.find((profile) => profile.id === profileId)?.name ??
      profileId ??
      "the current profile";
    // The saved sign-in for this page, once no signed-in profile can open it.
    const signInHere = Effect.gen(function* () {
      if (result !== "sign-in" || !isAutomaticSignInPage(url, page)) return undefined;
      const signedIn = yield* signInOnPage(scope, {
        requestedUrl: url,
        pageUrl: page.finalUrl,
        tabId,
        profileId,
      }).pipe(Effect.provideService(AgentInvocationContext, invocation));
      return signedIn && { ...(signedIn.status ?? status), accountsNote: signedIn.note };
    });
    if (decision.action === "note")
      return (
        (yield* signInHere) ?? {
          ...status,
          accountsNote: `This page shows ${decision.problem} in ${profileName}. Call scient_account_find_profile with this URL to find a profile that can open it.`,
        }
      );
    // Without the original identity, discovery cannot safely exclude its profile.
    if (profileId === undefined) return status;
    const accounts = yield* AccountsService;
    const remember = (winner: BrowserProfileId, opened: string) =>
      accounts
        .chooseProfile({ threadId: scope.threadId, profileId: winner, url: opened, siteOnly: true })
        .pipe(Effect.ignore);
    // Google keeps several accounts in one profile: first try its others in this tab.
    for (const email of yield* otherGoogleAccounts(scope, url, profileId)) {
      const asked = new URL(url);
      asked.searchParams.set("authuser", email);
      yield* invoke("navigate", { url: asked.href }, tabId);
      yield* invoke("accountWaitForLoad", {}, tabId);
      const seen = yield* decodeDetection(
        yield* invoke<unknown>("evaluate", { expression: profileDetectionScript }, tabId),
      );
      if (classifyProfilePage(asked.href, seen) !== "opens") continue;
      yield* remember(profileId, asked.href);
      const current = yield* invoke<PreviewAutomationStatus>("status", {}, tabId).pipe(
        Effect.orElseSucceed(() => status),
      );
      return { ...current, accountsNote: `Opened as ${email} in ${profileName}.` };
    }
    const found = yield* findProfiles(scope, invocation, url, {
      exclude: profileId,
      stopAtFirstOpen: true,
    });
    const best = found.profiles.find((profile) => profile.profileId === found.best);
    if (!best)
      return (
        (yield* signInHere) ?? {
          ...status,
          accountsNote:
            "This page needs another account; no allowed browser profile can open it. Ask the user to sign in or to allow a profile in Settings → Accounts & secrets.",
        }
      );
    const { tabId: _tabId, ...openInput } = options.input ?? {};
    const opened = yield* withAccountUse(
      { ...scope, unattended: true },
      { type: "profile", profileId: best.profileId },
      "open-profile",
      broker.invoke<PreviewAutomationStatus>({
        scope: invocation,
        operation: "open",
        input: { ...openInput, url, profileId: best.profileId, reuseExistingTab: false },
      }),
    );
    if (!opened.tabId) return status;
    yield* remember(best.profileId, url);
    yield* invoke("close", {}, tabId).pipe(Effect.orElseSucceed(() => undefined));
    const current = yield* invoke<PreviewAutomationStatus>("status", {}, opened.tabId).pipe(
      Effect.orElseSucceed(() => opened),
    );
    return {
      ...current,
      accountsNote: `Opened in ${best.name}${best.email ? ` (${best.email})` : ""}: ${profileName} showed ${decision.problem}.`,
    };
  }).pipe(
    Effect.orElseSucceed(() => status),
    Effect.catchDefect(() => Effect.succeed(status)),
  );
});
