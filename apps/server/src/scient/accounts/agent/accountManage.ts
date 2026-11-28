import {
  AccountsError,
  PROFILE_IMPORT_CAUSE_COPY,
  INCOGNITO_BROWSER_PROFILE_ID,
  type AccountId,
  type AccountSummary,
  type AccountTarget,
  type ProfileOperation,
  ThreadId,
  BrowserProfileId,
  type ProfileOperateResult,
} from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off -- Operation ids use the operating system CSPRNG.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { PreviewManager } from "../../../preview/Manager.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  AccountsService,
  fail,
  type AccountChangeBy,
  type AccountSessionScope,
} from "../AccountsService.ts";
import { profileVersion, widensAccess } from "../agentChanges.ts";
import { personTimeLeft } from "./cardAllowance.ts";
import { UNDO_FOR_MS } from "../removedAccounts.ts";
import { accountSessionScope } from "./scope.ts";
import { sourceName } from "../browserSources.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { pinBinds } from "../taskPinRules.ts";
import { pinFor } from "../taskPins.ts";
import type { TaskPin } from "../AccountPersistence.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import type { ScientAccountsToolkit } from "./tools.ts";

type Tools = (typeof ScientAccountsToolkit)["tools"];
type ManageInput = Tools["scient_account_manage"]["parametersSchema"]["Type"];
type ProfilesInput = Tools["scient_browser_profiles"]["parametersSchema"]["Type"];

const PAGE = 20;
const page = <A>(
  items: ReadonlyArray<A>,
  input: { readonly cursor?: number | undefined; readonly limit?: number | undefined },
) => {
  const start = input.cursor ?? 0;
  const end = start + (input.limit ?? PAGE);
  return {
    items: items.slice(start, end),
    ...(end < items.length ? { nextCursor: end } : {}),
  };
};

/** An account as an agent sees it to manage: never a value; its version for the next write. */
const described = (account: AccountSummary) => {
  const { details, controls } = account;
  return {
    accountId: account.accountId,
    name: account.name,
    kind: details.kind,
    sites: "sites" in details ? [...details.sites] : [],
    ...(details.kind === "website" && details.username !== undefined
      ? { username: details.username }
      : {}),
    ...(details.kind === "api-key" && details.envName ? { envName: details.envName } : {}),
    ...(details.kind === "website" && details.oneSession ? { oneSession: true } : {}),
    access: controls.access,
    readable: controls.visibility === "readable",
    ...(controls.scope.type === "projects" ? { scope: [...controls.scope.projectIds] } : {}),
    version: account.updatedAt,
    ...(account.signIn ? { signIn: account.signIn.state } : {}),
    ...(account.secrets.password?.verifiedAt
      ? { lastWorked: account.secrets.password.verifiedAt }
      : {}),
  };
};

/** The Undo receipt an agent passes back: the row and the removal Undo knows it by. */
const receipt = (accountId: AccountId, removalId: string) => `${accountId}/${removalId}`;

/**
 * `scient_account_manage` (AMENDMENTS 56): everything the person does to an account, but reading
 * a hidden value or loosening what binds agents. Off rows stay the person's.
 */
export const manageAccount = Effect.fn("AccountsAgent.manage")(function* <E, R>(
  input: ManageInput,
  check: (
    accountId: AccountId,
  ) => Effect.Effect<{ readonly state: string; readonly reason?: string | undefined }, E, R>,
) {
  const accounts = yield* AccountsService;
  const scope = yield* accountSessionScope();
  const session = yield* accounts.forSession(scope);
  if (!session.agentAccess)
    return { message: "Agent access to Accounts is off. The user can turn it on in Settings." };
  const by: AccountChangeBy = { threadId: scope.threadId, projectId: scope.projectId };
  if (input.action === "check_all") {
    const { items, nextCursor } = page(
      session.accounts.filter(({ controls }) => controls.access !== "off"),
      input,
    );
    const checked = yield* Effect.forEach(items, (account) =>
      check(account.accountId).pipe(
        Effect.map((result) => ({
          accountId: account.accountId,
          name: account.name,
          state: result.state,
          ...(result.reason ? { reason: result.reason } : {}),
        })),
        Effect.orElseSucceed(() => ({
          accountId: account.accountId,
          name: account.name,
          state: "unknown",
        })),
      ),
    );
    return { checked, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }
  if (input.action === "undo") {
    const [accountId, removalId] = (input.undo ?? "").split("/");
    if (!accountId || !removalId)
      return yield* fail("invalid-input", "Pass the undo a remove returned.");
    yield* accounts.agentRestore(accountId as AccountId, removalId, by);
    return { message: "Brought back." };
  }
  const account = session.accounts.find((item) => item.accountId === input.accountId);
  if (!account) return yield* fail("not-found", "Use an account from scient_accounts_list.");
  if (input.action === "get") return { account: described(account) };
  if (input.action === "pin_task" || input.action === "unpin_task") {
    const scheduledTaskId = input.scheduledTaskId;
    if (scheduledTaskId === undefined)
      return yield* fail("invalid-input", "Pass the scheduledTaskId from schedule_task.");
    // The task is checked where it lives: this project's, and not run by a webhook, whose
    // deliveries can't be replayed once a signed-out run skipped one.
    // The task's trigger read and the pin written as one edit, never across a trigger change.
    return yield* accounts.withTaskEdit(
      scheduledTaskId,
      Effect.gen(function* () {
        const scheduler = yield* Effect.serviceOption(ScheduledTaskService);
        if (Option.isNone(scheduler))
          return yield* fail("unavailable", "Scheduled tasks aren't available on this computer.");
        const task = (yield* scheduler.value.list().pipe(
          Effect.mapError(
            () =>
              new AccountsError({
                reason: "unavailable",
                message: "Scheduled tasks couldn't be read.",
              }),
          ),
        )).tasks.find((candidate) => candidate.id === scheduledTaskId);
        if (task === undefined || task.projectId !== scope.projectId)
          return yield* fail(
            "not-found",
            "Use a scheduledTaskId of this project's from list_scheduled_tasks.",
          );
        if (input.action === "pin_task" && task.schedule.type === "webhook")
          return yield* fail(
            "invalid-input",
            "A webhook task can't be pinned: its deliveries can't wait for a sign-in.",
          );
        let foreign = false;
        // Another project's pin is that project's, checked in the same locked write.
        const unlessForeign = (next: TaskPin | undefined) => (current: TaskPin | undefined) => {
          foreign = current !== undefined && !pinBinds(current, scope.projectId);
          return foreign ? current : next;
        };
        if (input.action === "unpin_task") {
          yield* accounts.updateTaskPin(scheduledTaskId, unlessForeign(undefined));
          if (foreign) return yield* fail("denied", "That task is pinned from another project.");
          return { message: "Unpinned: the task runs as it did before." };
        }
        if (account.details.kind !== "website")
          return yield* fail("invalid-input", "Pin a task to a website or university sign-in.");
        const { environmentId } = yield* AgentInvocationContext;
        const pin = pinFor(scheduledTaskId, account, environmentId, scope.projectId);
        if (pin === undefined)
          return yield* fail(
            "invalid-input",
            `${account.name} has no username yet, so its identity can't be checked. Check it first.`,
          );
        yield* accounts.updateTaskPin(scheduledTaskId, unlessForeign(pin));
        if (foreign) return yield* fail("denied", "That task is pinned from another project.");
        return {
          message: `Pinned: each run uses only ${account.name}, in its profile on this computer, and checks it first.`,
        };
      }),
    );
  }
  if (input.action === "activity") {
    const target = { type: "account" as const, accountId: account.accountId };
    const used = yield* accounts.activity({ target, limit: 200 });
    const changed = ((yield* accounts.snapshot).changes ?? []).filter(
      (change) => change.target.type === "account" && change.target.accountId === account.accountId,
    );
    const entries = [
      ...used.map((entry) => ({
        at: entry.at,
        action: entry.action,
        ...(entry.outcome ? { outcome: entry.outcome } : {}),
        ...(entry.detail ? { detail: entry.detail } : {}),
        ...(entry.threadId ? { byChat: entry.threadId } : {}),
      })),
      ...changed.map((change) => ({
        at: change.at,
        action: change.change,
        ...(change.detail ? { detail: change.detail } : {}),
        ...(change.threadId ? { byChat: change.threadId } : {}),
      })),
    ].toSorted((a, b) => b.at.localeCompare(a.at));
    const { items, nextCursor } = page(entries, input);
    return { entries: items, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }
  // Writes: each names the version it read; the service checks it, Off and scope at commit.
  if (input.version === undefined)
    return yield* fail("invalid-input", "Pass the version from get.");
  if (account.controls.access === "off" && input.action !== "controls")
    return yield* fail("denied", "This account is off for agents; the user manages it.");
  if (input.action === "save_offer") {
    yield* accounts.agentSaveOffer(account.accountId, input.version, by);
    return { message: "Scient offers to save sign-ins for this site again." };
  }
  if (input.action === "edit")
    return {
      account: described(
        yield* accounts.agentEdit(
          account.accountId,
          input.version,
          {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.username === undefined ? {} : { username: input.username }),
            ...(input.sites === undefined ? {} : { sites: input.sites }),
            ...(input.oneSession === undefined ? {} : { oneSession: input.oneSession }),
          },
          by,
        ),
      ),
    };
  if (input.action === "controls") {
    const target = { type: "account" as const, accountId: account.accountId };
    // More access is the person's: the Turn on card asks them, as for a use.
    if (account.controls.access === "off" || widensAccess(account.controls, input.access))
      return yield* turnOnCard(scope, target);
    yield* accounts.agentControls(
      {
        target,
        ...(input.access ? { access: input.access } : {}),
        ...(input.scope ? { scope: { type: "projects", projectIds: input.scope } } : {}),
        ...(input.hidden ? { visibility: "hidden" as const } : {}),
        ...(input.readOnly ? { permission: "read-only" as const } : {}),
      },
      input.version,
      by,
    );
    return { message: "Controls tightened." };
  }
  // remove: the person's own Remove, with the same Undo for the hour.
  const { removalId } = yield* accounts.agentRemove(account.accountId, input.version, by);
  const until = (yield* Clock.currentTimeMillis) + UNDO_FOR_MS;
  return {
    undo: receipt(account.accountId, removalId),
    undoUntil: DateTime.formatIso(DateTime.makeUnsafe(until)),
    message: "Removed. The user sees it in Accounts with Undo for an hour.",
  };
});

/** The person's existing Turn on card for an agent asking for more access than it has. */
const turnOnCard = Effect.fn("AccountsAgent.turnOnCard")(function* (
  scope: AccountSessionScope,
  target: AccountTarget,
) {
  const decided = yield* (yield* AccountsService).authorize(
    scope,
    target,
    target.type === "account" ? "credentials" : "open-profile",
    { waitMs: yield* personTimeLeft },
  );
  return {
    message:
      decided.decision === "allowed"
        ? "The user turned it on for agents."
        : "The user didn't turn it on. Don't ask again this turn.",
  };
});

/** A profile operation's receipt for an agent: what each store did, never a value. */
const receiptOf = (operation: ProfileOperation) => ({
  operationId: operation.operationId,
  kind: operation.kind,
  undoUntil: operation.until,
  ...(operation.server ? { server: operation.server.state } : {}),
  ...(operation.desktop ? { desktop: operation.desktop.state } : {}),
  // What didn't come over or why it stopped, so a partial result isn't reported as done.
  ...(() => {
    const uncovered = [
      ...new Set([
        ...(operation.uncovered ?? []),
        ...(operation.server?.uncovered ?? []),
        ...(operation.desktop?.uncovered ?? []),
      ]),
    ];
    return uncovered.length ? { notCopied: uncovered.slice(0, 20) } : {};
  })(),
  ...(operation.stopped ? { stopped: operation.stopped } : {}),
  ...(operation.undone ? { undone: true } : {}),
  ...(operation.undone?.conflicts?.length ? { keptSince: [...operation.undone.conflicts] } : {}),
});

/** The chats with a tab open in a profile, on this server. */
const openTabsIn = (profileId: string) =>
  Effect.serviceOption(PreviewManager).pipe(
    Effect.flatMap((manager) =>
      Option.isSome(manager) ? manager.value.profileTabs(profileId) : Effect.succeed([]),
    ),
    Effect.map((tabs) => [...new Set(tabs.map(({ threadId }) => ThreadId.make(threadId)))]),
  );

/** Chats by their titles, for an agent to tell the user which to close. */
const chatTitles = (threadIds: ReadonlyArray<ThreadId>) =>
  Effect.serviceOption(ProjectionStoreV2).pipe(
    Effect.flatMap((store) =>
      Effect.forEach(threadIds, (threadId) =>
        Option.isSome(store)
          ? store.value.getThreadShell(threadId).pipe(
              Effect.map((shell): string => shell?.title ?? threadId),
              Effect.orElseSucceed(() => threadId as string),
            )
          : Effect.succeed(threadId as string),
      ),
    ),
  );

/** What an agent is told: done only once every store has ended, and how it ended (round 6d). */
const replyFor = (operation: ProfileOperation) => {
  const stores = [
    operation.server,
    operation.desktop,
    ...(operation.others ?? []).map(({ outcome }) => outcome),
  ].filter((store) => store !== undefined);
  // A refresh has no Undo: its Activity line is the record (round 6m).
  const seen =
    operation.kind === "refresh"
      ? "The user sees it in the profile's Activity."
      : "The user sees it with Undo for an hour.";
  if (stores.some((store) => store.state === "pending"))
    return operation.kind === "refresh"
      ? "Started; not done yet. Check status."
      : "Started; not done yet. Check status: the user's Undo begins once it ends.";
  if (operation.stopped) return `Stopped: ${operation.stopped}`;
  // An import's failure names its cause and the one thing to do (round 6d).
  const cause = stores.find((store) => store.cause)?.cause;
  if (cause) return `Didn't finish: ${PROFILE_IMPORT_CAUSE_COPY[cause]}`;
  // What each desktop left, named: never "done" with cookies still signed in (round 6e).
  const parts = [
    ...[operation.server, operation.desktop].flatMap((outcome) =>
      outcome ? [{ on: "this computer", outcome }] : [],
    ),
    ...(operation.others ?? []).map(({ computer, outcome }) => ({ on: computer.label, outcome })),
  ];
  const left = parts.flatMap(({ on, outcome }) => [
    ...(outcome.state === "failed" && on !== "this computer" ? [`not done on ${on}`] : []),
    ...(outcome.leftBehind
      ? [`${outcome.leftBehind} cookies couldn't be signed out on ${on}`]
      : []),
    ...(outcome.notRestorable
      ? [`Undo can't put ${outcome.notRestorable} cookies back on ${on}`]
      : []),
    ...(outcome.uncovered?.length
      ? [`not copied: ${outcome.uncovered.slice(0, 5).join(", ")}`]
      : []),
  ]);
  if (left.length) return `Partly done: ${left.join("; ")}. ${seen}`;
  if (stores.some((store) => store.state === "failed"))
    return `Partly done: a part failed. ${seen}`;
  const passwords = stores.find((store) => store.passwords !== undefined)?.passwords;
  if (operation.kind === "refresh")
    return `Done: ${stores.reduce((sum, store) => sum + (store.copied ?? 0), 0)} sites' sign-ins${operation.passwords ? `, ${passwords ?? 0} passwords` : ""}. ${seen}`;
  return `Done. ${seen}`;
};

/** One agent call's operation id: the same chat, action and arguments give the same id. */
const sameCall = (...parts: ReadonlyArray<unknown>) =>
  `agent-${NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 40)}`;

/**
 * The request: the same call while its receipt is live and not undone is a retry and gets that
 * receipt; otherwise it is a new request with a fresh id, never one used before, whatever was
 * evicted since, and anything named after it (a new profile) is new too (rounds 6d, 6e). The
 * call's key, kept on the receipt, is what retries match.
 */
const request = (...parts: ReadonlyArray<unknown>) => ({
  operationId: `agent-${NodeCrypto.randomBytes(20).toString("hex")}`,
  // Matched by Accounts under its admission permit: a retry gets the first receipt (round 6f).
  requestKey: sameCall(...parts),
});

/** An import's or refresh's reply: refused, or started on the desktop that holds the source. */
const importReply = (result: ProfileOperateResult) =>
  result.operation
    ? {
        operation: receiptOf(result.operation),
        ...(result.operation.madeProfile ? { profileId: result.operation.profileId } : {}),
        message: `Started on ${result.operation.computer?.label ?? "this desktop"}; it may wait for the user to allow the browser. Check status. Sign-ins it brings show as imported until a page confirms them.`,
      }
    : { message: result.refused?.message ?? "Refused." };

/** `scient_browser_profiles`, stage A: bounded reads and only-tighter controls. */
export const manageBrowserProfiles = Effect.fn("AccountsAgent.browserProfiles")(function* (
  input: ProfilesInput,
) {
  const accounts = yield* AccountsService;
  const scope = yield* accountSessionScope();
  const session = yield* accounts.forSession(scope);
  if (!session.agentAccess)
    return { message: "Agent access to Accounts is off. The user can turn it on in Settings." };
  if (input.action === "list") {
    const { items, nextCursor } = page(
      session.profiles.filter(({ profileId }) => profileId !== INCOGNITO_BROWSER_PROFILE_ID),
      input,
    );
    return {
      profiles: items.map((profile) => ({
        profileId: profile.profileId,
        version: profileVersion(profile),
        // The name a client lists it under; else the source browser's.
        name: profile.name ?? profile.source?.profileName ?? profile.profileId,
        access: profile.access,
        ...(profile.scope.type === "projects" ? { scope: [...profile.scope.projectIds] } : {}),
        scriptSignIn: profile.scriptSignIn,
        ...(profile.received?.length ? { fromAnotherComputer: true } : {}),
      })),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }
  if (input.action === "sources") {
    // Only what names a profile: never a cookie, password or history.
    const { items, nextCursor } = page(yield* accounts.browserSources, input);
    return {
      sources: items.map(({ sourceId, computer, connected, source }) => ({
        sourceId,
        name: sourceName(source),
        ...(source.email ? { email: source.email } : {}),
        computer: computer.label,
        ...(source.linkedTo ? { linkedTo: source.linkedTo } : {}),
        ...(connected ? {} : { offline: true }),
      })),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }
  const by = { threadId: scope.threadId, projectId: scope.projectId };
  if (input.action === "undo" || input.action === "status") {
    if (!input.operationId)
      return yield* fail("invalid-input", "Pass the operationId it returned.");
    const operation =
      input.action === "undo"
        ? yield* accounts.undoProfileOperation(input.operationId, by)
        : ((yield* accounts.snapshot).profileOperations ?? []).find(
            ({ operationId, threadId }) =>
              operationId === input.operationId && threadId === scope.threadId,
          );
    if (!operation) return yield* fail("not-found", "No such operation in this chat this hour.");
    return {
      operation: receiptOf(operation),
      ...(input.action === "status" && !operation.undone ? { message: replyFor(operation) } : {}),
    };
  }
  // An import from a source into a new profile: the default when no profile is named.
  if (input.action === "import" && input.sourceId && !input.profileId) {
    // The same call again, as a retry, is the same import: its receipt, not a second profile.
    const { operationId: id, requestKey } = request(
      scope.threadId,
      "import",
      input.sourceId,
      input.cookies,
      input.passwords,
    );
    const result = yield* accounts.operateProfile(
      {
        operationId: id,
        requestKey,
        kind: "refresh",
        profileId: BrowserProfileId.make(`profile-${id.slice("agent-".length)}`),
        sourceId: input.sourceId,
        ...(input.cookies ? { cookies: true } : {}),
        ...(input.passwords ? { passwords: true } : {}),
      },
      by,
      [],
    );
    return importReply(result);
  }
  const profile = session.profiles.find((item) => item.profileId === input.profileId);
  if (!profile) return yield* fail("not-found", "Use a profile from list.");
  if (input.action === "sites") {
    const rows = session.accounts.filter(
      ({ details }) =>
        details.kind === "website" &&
        (details.profileId ?? "default") === (profile.profileId as BrowserProfileId),
    );
    const { items, nextCursor } = page(rows, input);
    return {
      sites: items.map((account) => ({
        site: "sites" in account.details ? (account.details.sites[0] ?? "") : "",
        accountId: account.accountId,
        ...(account.details.kind === "website" && account.details.username !== undefined
          ? { username: account.details.username }
          : {}),
        ...(account.signIn ? { signIn: account.signIn.state } : {}),
      })),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }
  // A profile set on another computer is controlled there, as for the person.
  if (profile.received?.length)
    return yield* fail("denied", "This profile is set on another computer; change it there.");
  if (input.version === undefined)
    return yield* fail("invalid-input", "Pass the version from list.");
  if (
    input.action === "sign_out" ||
    input.action === "clear" ||
    input.action === "remove" ||
    input.action === "transfer" ||
    input.action === "merge" ||
    input.action === "fold_main" ||
    input.action === "import" ||
    input.action === "refresh"
  ) {
    if (input.action === "sign_out" && !input.site)
      return yield* fail("invalid-input", "Name the site to sign out of.");
    if ((input.action === "transfer" || input.action === "merge") && !input.into)
      return yield* fail("invalid-input", "Name the profile they go into.");
    if (input.action === "transfer" && !input.sites?.length)
      return yield* fail("invalid-input", "Name the sites to copy.");
    const result = yield* accounts.operateProfile(
      {
        // A retry of the same call at the same version gets its receipt, never a second one.
        ...request(
          scope.threadId,
          input.action,
          profile.profileId,
          input.version,
          input.site,
          input.into,
          input.mode,
          input.sites,
          input.cookies,
          input.passwords,
          input.sourceId,
        ),
        kind:
          input.action === "sign_out"
            ? "sign-out"
            : input.action === "transfer"
              ? (input.mode ?? "copy")
              : input.action === "fold_main"
                ? "fold"
                : input.action === "import"
                  ? "refresh"
                  : input.action,
        profileId: profile.profileId,
        ...(input.site ? { site: input.site } : {}),
        ...(input.into && input.action !== "fold_main" ? { into: input.into } : {}),
        ...(input.sites?.length && input.action === "transfer" ? { sites: [...input.sites] } : {}),
        ...(input.cookies ? { cookies: true } : {}),
        ...(input.passwords ? { passwords: true } : {}),
        ...(input.action === "import" && input.sourceId ? { sourceId: input.sourceId } : {}),
      },
      by,
      openTabsIn(profile.profileId),
      input.version,
    );
    if (result.operation?.kind === "refresh") return importReply(result);
    if (result.refused)
      return {
        message: result.refused.message,
        ...(result.refused.threadIds?.length
          ? { openIn: yield* chatTitles(result.refused.threadIds) }
          : {}),
      };
    return {
      operation: receiptOf(result.operation!),
      message: replyFor(result.operation!),
    };
  }
  const target = { type: "profile" as const, profileId: profile.profileId };
  if (profile.access === "off" || widensAccess(profile, input.access))
    return yield* turnOnCard(scope, target);
  yield* accounts.agentControls(
    {
      target,
      ...(input.access ? { access: input.access } : {}),
      ...(input.scope ? { scope: { type: "projects", projectIds: input.scope } } : {}),
      ...(input.scriptSignIn === false ? { scriptSignIn: false } : {}),
    },
    input.version,
    { threadId: scope.threadId, projectId: scope.projectId },
  );
  return { message: "Controls tightened." };
});
