import * as Option from "effect/Option";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { requireThreadMcpCapability } from "../../../mcp/McpInvocationContext.ts";
import { scientInvocationForMcp } from "../../../mcp/ScientMcpInvocation.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { accountSessionScope } from "./scope.ts";
import {
  AccountsError,
  DEFAULT_BROWSER_PROFILE_ID,
  defaultBrowserProfileRecord,
  type PreviewTabId,
  type PreviewAutomationOpenInput,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { pickBrowserProfile, profileSignIns } from "@t3tools/shared/scientBrowserProfileChoice";
import { authorizationDecision } from "../AccountDecisions.ts";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";

const profileIds = (status: PreviewAutomationStatus) => [
  ...new Set([
    ...(status.profiles?.map((profile) => profile.id) ?? []),
    ...(status.tabs?.flatMap((tab) => (tab.profileId ? [tab.profileId] : [])) ?? []),
  ]),
];

export const authorizePreviewTab = Effect.fn("AccountsAgent.authorizePreviewTab")(function* (
  scope: AccountSessionScope,
  status: PreviewAutomationStatus,
  tabId: PreviewTabId | undefined,
) {
  const accounts = yield* AccountsService;
  const session = yield* accounts.forSession(scope, profileIds(status));
  const tab = status.tabs?.find((item) => item.tabId === (tabId ?? status.tabId));
  if (
    !session.agentAccess ||
    !tab?.profileId ||
    !session.profiles.some(
      (profile) => profile.profileId === tab.profileId && profile.access !== "off",
    )
  )
    return yield* new AccountsError({
      reason: "denied",
      message:
        "This browser profile is unavailable to this session. Change its access in Settings → Accounts & secrets.",
    });
  // Autofill fills every tab for the user; a tab holding a sign-in this agent may not use stays
  // closed to it while it shows that site (a page may change its address without clearing the
  // form), so the agent cannot read the filled password.
  const filled = yield* accounts.filledTab(scope.threadId, tab.tabId);
  const site = (url: string | null | undefined) =>
    url && URL.canParse(url) ? new URL(url).origin : url;
  if (
    filled &&
    site(filled.url) === site(tab.url) &&
    !session.accounts.some(
      (account) =>
        account.accountId === filled.accountId &&
        authorizationDecision(session.agentAccess, account.controls, scope).decision === "allowed",
    )
  )
    return yield* new AccountsError({
      reason: "denied",
      message:
        "The user signed in on this tab with an account you may not use. Use another tab for this site.",
    });
});

export const filterPreviewProfiles = Effect.fn("AccountsAgent.filterPreviewProfiles")(function* (
  scope: AccountSessionScope,
  status: PreviewAutomationStatus,
) {
  const accounts = yield* AccountsService;
  const session = yield* accounts.forSession(scope, profileIds(status));
  const allowed = (id: string | undefined) =>
    session.agentAccess &&
    session.profiles.some((profile) => profile.profileId === id && profile.access !== "off");
  const profiles = status.profiles?.filter((profile) => allowed(profile.id));
  const tabs = status.tabs?.filter((tab) => allowed(tab.profileId));
  const { defaultProfileId, ...rest } = status;
  const current = status.tabs?.find((tab) => tab.tabId === status.tabId);
  return {
    ...(status.tabId === null || allowed(current?.profileId)
      ? rest
      : {
          available: status.available,
          visible: status.visible,
          tabId: null,
          url: null,
          title: null,
          loading: false,
        }),
    ...(tabs === undefined ? {} : { tabs }),
    ...(profiles === undefined ? {} : { profiles }),
    ...(defaultProfileId !== undefined && allowed(defaultProfileId) ? { defaultProfileId } : {}),
  };
});

export const authorizePreviewProfile = Effect.fn("AccountsAgent.authorizePreviewProfile")(
  function* (
    scope: AccountSessionScope,
    status: PreviewAutomationStatus,
    input: PreviewAutomationOpenInput,
    action: "open-profile" | "browser-session" = "open-profile",
  ) {
    const accounts = yield* AccountsService;
    const existing =
      input.reuseExistingTab !== false
        ? status.tabs?.find((tab) => tab.tabId === (input.tabId ?? status.tabId))
        : undefined;
    const profile =
      input.profileId === undefined
        ? undefined
        : status.profiles?.find(
            (item) => item.id === input.profileId || item.name === input.profileId,
          );
    const choosing = existing?.profileId === undefined && input.profileId === undefined;
    const known = choosing
      ? yield* accounts.forSession(
          scope,
          status.profiles?.map((item) => item.id),
        )
      : undefined;
    // Without a named profile, the same order as the user's own tabs: their switch for this site
    // here, the profile signed in to the site, this conversation's, the project's, the default.
    const profileId =
      existing?.profileId ??
      profile?.id ??
      (known
        ? pickBrowserProfile({
            url: input.url,
            threadId: scope.threadId,
            projectId: scope.projectId,
            profiles: (status.profiles ?? []).flatMap((item) => {
              const record = known.profiles.find((entry) => entry.profileId === item.id);
              return known.agentAccess &&
                record &&
                authorizationDecision(known.agentAccess, record, scope).decision === "allowed"
                ? [item.id]
                : [];
            }),
            signIns: profileSignIns(known.accounts),
            choices: known.profileChoices,
            defaultProfileId: status.defaultProfileId ?? DEFAULT_BROWSER_PROFILE_ID,
          }).profileId
        : undefined);
    if (profileId === undefined)
      return yield* new AccountsError({
        reason: "denied",
        message:
          "The browser profile could not be resolved. Read preview_status and choose an available profile.",
      });
    const decision = yield* accounts.authorize(scope, { type: "profile", profileId }, action);
    if (decision.decision === "denied")
      return yield* new AccountsError({
        reason: "denied",
        message:
          "This browser profile is unavailable to this session. Change its access in Settings → Accounts & secrets.",
      });
    const session = yield* accounts.forSession(
      scope,
      status.profiles?.map((profile) => profile.id),
    );
    const record =
      session.profiles.find((item) => item.profileId === profileId) ??
      defaultBrowserProfileRecord(profileId);
    if (action === "browser-session" && !record.scriptSignIn)
      return yield* new AccountsError({
        reason: "denied",
        message:
          "Script sign-ins are disabled for this browser profile in Settings → Accounts & secrets.",
      });
    return { profileId, record };
  },
);

const previewAccountScope = Effect.fn("AccountsAgent.previewScope")(function* () {
  const scope = yield* requireThreadMcpCapability("preview");
  return yield* accountSessionScope().pipe(
    Effect.provideService(AgentInvocationContext, scientInvocationForMcp(scope)),
  );
});

export const withPreviewAccounts = Effect.fn("AccountsAgent.withPreviewAccounts")(function* <
  A,
  E,
  R,
>(
  fallback: Effect.Effect<A, E, R>,
  action: (scope: AccountSessionScope) => Effect.Effect<A, E | AccountsError, R | AccountsService>,
) {
  const accounts = yield* Effect.serviceOption(AccountsService);
  if (Option.isNone(accounts)) return yield* fallback;
  const projections = yield* Effect.serviceOption(ProjectionStoreV2);
  if (Option.isNone(projections))
    return yield* new AccountsError({
      reason: "unavailable",
      message: "The account session could not be resolved.",
    });
  const scope = yield* previewAccountScope().pipe(
    Effect.provideService(ProjectionStoreV2, projections.value),
  );
  return yield* action(scope).pipe(Effect.provideService(AccountsService, accounts.value));
});

export const recordProfileUse = Effect.fn("AccountsAgent.recordProfileUse")(function* <A, E, R>(
  scope: AccountSessionScope,
  profileId: import("@t3tools/contracts").BrowserProfileId,
  operation: Effect.Effect<A, E, R>,
) {
  const accounts = yield* AccountsService;
  return yield* operation.pipe(
    Effect.onExit((exit) =>
      accounts.recordUse({
        target: { type: "profile", profileId },
        action: "open-profile",
        threadId: scope.threadId,
        ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
        outcome: exit._tag === "Success" ? "ok" : "error",
      }),
    ),
  );
});
