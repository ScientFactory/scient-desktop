import type {
  BrowserProfileId,
  PreviewAutomationOpenInput,
  PreviewAutomationStatus,
  PreviewTabId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { requireThreadMcpCapability } from "../../../mcp/McpInvocationContext.ts";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { scientInvocationForMcp } from "../../../mcp/ScientMcpInvocation.ts";
import type { AccountSessionScope } from "../AccountsService.ts";
import { withAccountUse } from "./accountUse.ts";
import { findProfiles } from "./findProfiles.ts";
import { classifyProfilePage } from "./profileClassification.ts";
import { ProfileDetection, profileDetectionScript } from "./profileDetection.ts";
import { profileOpenDecision } from "./profileOpenDecision.ts";

const decodeDetection = Schema.decodeUnknownEffect(ProfileDetection);

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
    const invoke = <A>(
      operation: Parameters<typeof broker.invoke>[0]["operation"],
      input: unknown,
      tabId: PreviewTabId,
    ) => broker.invoke<A>({ scope: invocation, operation, input, tabId, updateCurrentTab: false });
    yield* invoke("accountWaitForLoad", {}, tabId);
    const raw = yield* invoke<unknown>("evaluate", { expression: profileDetectionScript }, tabId);
    const page = yield* decodeDetection(raw);
    const decision = profileOpenDecision(classifyProfilePage(url, page), {
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
    if (decision.action === "note")
      return {
        ...status,
        accountsNote: `This page shows ${decision.problem} in ${profileName}. Call scient_account_find_profile with this URL to find a profile that can open it.`,
      };
    // Without the original identity, discovery cannot safely exclude its profile.
    if (profileId === undefined) return status;
    const found = yield* findProfiles(scope, invocation, url, {
      exclude: profileId,
      stopAtFirstOpen: true,
    });
    const best = found.profiles.find((profile) => profile.profileId === found.best);
    if (!best)
      return {
        ...status,
        accountsNote:
          "This page needs another account; no allowed browser profile can open it. Ask the user to sign in or to allow a profile in Settings → Accounts.",
      };
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
