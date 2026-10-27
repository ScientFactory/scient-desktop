import {
  INCOGNITO_BROWSER_PROFILE_ID,
  AccountsError,
  type BrowserProfileId,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import type { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { withAccountUse } from "./accountUse.ts";
import { classifyProfilePage, type ProfileResult } from "./profileClassification.ts";
import { ProfileDetection, profileDetectionScript } from "./profileDetection.ts";

const decodeProfileDetection = Schema.decodeUnknownEffect(ProfileDetection);
const fail = (reason: AccountsError["reason"], message: string) =>
  new AccountsError({ reason, message });

export const findProfiles = Effect.fn("AccountsAgent.findProfiles")(function* (
  scope: AccountSessionScope,
  invocation: AgentInvocationContext["Service"],
  url: string,
  options: { exclude?: BrowserProfileId; stopAtFirstOpen?: boolean } = {},
) {
  if (!invocation.capabilities.has("preview"))
    return yield* fail("denied", "Browser access is disabled for this session.");
  if (
    !URL.canParse(url) ||
    new URL(url).protocol !== "https:" ||
    new URL(url).username ||
    new URL(url).password
  )
    return yield* fail("invalid-input", "Choose an HTTPS URL without credentials.");
  const accounts = yield* AccountsService;
  const broker = yield* PreviewAutomationBroker;
  const invoke = <A>(
    operation: Parameters<typeof broker.invoke>[0]["operation"],
    data: unknown,
    tabId?: PreviewTabId,
  ) =>
    broker
      .invoke<A>({
        scope: invocation,
        operation,
        input: data,
        ...(tabId === undefined ? {} : { tabId }),
        updateCurrentTab: false,
      })
      .pipe(Effect.mapError(() => fail("unavailable", "The profile could not be checked.")));
  const status = yield* invoke<PreviewAutomationStatus>("status", {});
  const session = yield* accounts.forSession(
    scope,
    status.profiles?.map((profile) => profile.id),
  );
  if (!session.agentAccess)
    return yield* fail("denied", "Agent access is disabled in Settings → Accounts.");
  const profiles: Array<{
    profileId: BrowserProfileId;
    name: string;
    email?: string;
    result: typeof ProfileResult.Type;
  }> = [];
  const skipped: string[] = [];
  for (const profile of status.profiles ?? []) {
    const record = session.profiles.find((item) => item.profileId === profile.id);
    if (!record || profile.id === options.exclude) continue;
    if (
      profile.incognito ||
      profile.id === INCOGNITO_BROWSER_PROFILE_ID ||
      record.access !== "allowed" ||
      profiles.length >= 8
    ) {
      skipped.push(profile.name);
      continue;
    }
    const result = yield* withAccountUse(
      // A grant changed to Ask during discovery must never prompt.
      { ...scope, unattended: true },
      { type: "profile", profileId: profile.id },
      "open-profile",
      Effect.acquireUseRelease(
        invoke<PreviewAutomationStatus>("open", {
          url,
          profileId: profile.id,
          open: false,
          reuseExistingTab: false,
        }),
        (opened) =>
          Effect.gen(function* () {
            if (!opened.tabId)
              return yield* fail("unavailable", "No browser tab is available for this profile.");
            yield* invoke("accountWaitForLoad", {}, opened.tabId);
            const raw = yield* invoke<unknown>(
              "evaluate",
              { expression: profileDetectionScript },
              opened.tabId,
            );
            const page = yield* decodeProfileDetection(raw).pipe(
              Effect.mapError(() => fail("unavailable", "The profile could not be checked.")),
            );
            return classifyProfilePage(url, page);
          }),
        (opened) => (opened.tabId ? invoke<void>("close", {}, opened.tabId) : Effect.void),
      ),
      (result) => result !== "error",
    ).pipe(Effect.orElseSucceed(() => classifyProfilePage(url, undefined)));
    profiles.push({
      profileId: profile.id,
      name: profile.name,
      ...(record.source?.email ? { email: record.source.email } : {}),
      result,
    });
    if (options.stopAtFirstOpen && result === "opens") break;
  }
  const best = profiles.find((profile) => profile.result === "opens")?.profileId;
  return {
    profiles,
    ...(best === undefined ? {} : { best }),
    ...(skipped.length ? { skipped } : {}),
  };
});
