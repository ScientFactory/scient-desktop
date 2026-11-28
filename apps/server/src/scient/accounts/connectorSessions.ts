// @effect-diagnostics nodeBuiltinImport:off -- A connector's session files are owner-only files in Scient's secrets folder.
/**
 * Sessions for local connectors that sign in to a website: the site's current cookies from the
 * linked sign-in's browser profile, written to owner-only files the program reads, and Scient's
 * own unattended sign-in (saved password and authenticator code) when the session ends. The
 * program never gets the password.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type AccountId,
  type AccountSummary,
  DEFAULT_BROWSER_PROFILE_ID,
  type PreviewAutomationStatus,
  type ProjectId,
  type SessionCookie,
  ThreadId,
} from "@t3tools/contracts";
import {
  cookieHeaderFor,
  cookieValueDigest,
  decideWriteBack,
  isWriteBackSlot,
} from "@t3tools/shared/scientCookieWriteBack";
import { anySiteMatches } from "@t3tools/shared/scientSiteMatch";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { AgentInvocationContext } from "../operations/AgentInvocationContext.ts";
import { agentAccessOff, inScope } from "./AccountDecisions.ts";
import { AccountsService } from "./AccountsService.ts";
import { previewInvoker } from "./agent/broker.ts";
import { AccountCookies, netscapeCookieJar } from "./agent/cookies.ts";
import { guardedSignIn } from "./agent/guardedSignIn.ts";
import { privateDirectory, writePrivateFile } from "./agent/sessionFiles.ts";
import { userRunInvocation } from "./checkAccounts.ts";
import { isUniversitySignInService } from "./signInTabs.ts";
import {
  readOutcome,
  readSite,
  siteTransport,
  type SiteTransport,
  type WebsiteReadOutcome,
} from "./websiteRead.ts";

const decodeCookies = Schema.decodeUnknownEffect(AccountCookies);
const encodeCookies = Schema.encodeSync(Schema.fromJsonString(AccountCookies));

/** Connectors' sign-ins are no agent's run: they act under their own identity. */
const CONNECTOR_THREAD = ThreadId.make("scient-connector-sessions");
/** Cookie values this long are hidden (as whole tokens, so ordinary words stay intact). */
const MIN_HIDDEN = 6;

export interface ConnectorSessionTarget {
  readonly connectorId: string;
  readonly accountId: string;
  /** The manifest's `signIn` site, as an https origin. */
  readonly site: string;
  readonly projectId?: ProjectId | undefined;
  /** The scheduled task the calling run serves: a pin on it binds which sign-in may be used. */
  readonly scheduledTaskId?: string | undefined;
}

/** Why a session cannot be handed over now; `needs-user` means only the person can fix it. */
export interface ConnectorSessionProblem {
  readonly reason: "needs-user" | "unavailable";
  readonly message: string;
}

export interface PreparedConnectorSession {
  readonly environment: Readonly<Record<string, string>>;
  /** Cookie values to keep out of the program's logs. */
  readonly hide: ReadonlyArray<string>;
}

export interface SessionMark {
  readonly sequence: number;
  /** The site's cookies but the rotating slot. */
  readonly cookies: string;
  /** The rotating slot's value digest, when the session has one. */
  readonly slot?: string | undefined;
  /** The address the token comes from: its cookies are the session, a deeper slot's included. */
  readonly url: string;
}

/** The one session cookie a connector's reads may keep rotated, from its manifest. */
export interface WriteBackSlot {
  readonly cookie: string;
  readonly path: string;
}

/** A read Scient made for a connector: the site's answer, and what became of the session cookie. */
export interface WebsiteReadResult {
  readonly outcome: WebsiteReadOutcome;
  readonly status?: number;
  readonly contentType?: string;
  readonly body?: string;
  /** Where a redirect pointed; Scient follows none. */
  readonly location?: string;
  /** A reason code, never a value: `newer` means the profile changed it meanwhile and won. */
  readonly kept: "unchanged" | "rotated" | "deleted" | "newer" | "refused" | "fenced" | "lost";
}

export interface ConnectorSessionsShape {
  /** Website and university sign-ins that cover the site, for linking one to a connector. */
  readonly accountsFor: (site: string) => Effect.Effect<ReadonlyArray<AccountSummary>>;
  readonly account: (accountId: string) => Effect.Effect<AccountSummary | undefined>;
  /**
   * Writes the site's current cookies to the connector's session files. With no cookies yet,
   * Scient signs in first.
   */
  readonly prepare: (
    target: ConnectorSessionTarget,
  ) => Effect.Effect<PreparedConnectorSession, ConnectorSessionProblem>;
  /** Signs in again after the site ended the session, then rewrites the session files. */
  readonly signInAgain: (
    target: ConnectorSessionTarget,
  ) => Effect.Effect<PreparedConnectorSession, ConnectorSessionProblem>;
  /** Whether the sign-in may still be used: it exists, covers the site, and is on and in scope. */
  readonly allowed: (target: ConnectorSessionTarget) => Effect.Effect<boolean>;
  readonly remove: (connectorId: string) => Effect.Effect<void>;
  /**
   * The session as it is now: its sign-out fence and a digest of the site's cookies, less the
   * slot that reads keep rotated.
   */
  readonly sessionMark: (
    target: ConnectorSessionTarget,
    slot: WriteBackSlot | undefined,
    url: string,
  ) => Effect.Effect<SessionMark, ConnectorSessionProblem>;
  /**
   * Whether something made from the session at `mark` (a minted token) may still go out:
   * `refused` once the link no longer allows it or the site was signed out of since, `changed`
   * once the profile holds another session.
   */
  readonly sessionStands: (
    target: ConnectorSessionTarget,
    slot: WriteBackSlot | undefined,
    mark: SessionMark,
  ) => Effect.Effect<"stands" | "changed" | "refused">;
  /**
   * A read on the site that Scient makes itself with the profile's session (`url` is on the
   * site). Only the site's rotation or deletion of `slot`, when one is named, goes back into the
   * profile.
   */
  readonly readWithWebsiteSession: (
    target: ConnectorSessionTarget,
    slot: WriteBackSlot | undefined,
    url: string,
  ) => Effect.Effect<WebsiteReadResult, ConnectorSessionProblem>;
}

const problem = (reason: ConnectorSessionProblem["reason"], message: string) =>
  Effect.fail<ConnectorSessionProblem>({ reason, message });

const hostOf = (site: string) => (URL.canParse(site) ? new URL(site).host : site);

export const needsYouMessage = (site: string) =>
  `${hostOf(site)} needs you to sign in: open Settings → Accounts, or the connector's page in Settings → Extensions.`;

export const makeConnectorSessions = Effect.fn("ConnectorSessions.make")(function* (options: {
  readonly secretsDir: string;
  readonly transport?: SiteTransport;
}) {
  const accounts = yield* AccountsService;
  const broker = yield* PreviewAutomationBroker;
  const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
  const invocation = userRunInvocation(CONNECTOR_THREAD, environmentId);
  const root = NodePath.join(options.secretsDir, "connector-sessions");
  const folderOf = (connectorId: string) =>
    NodePath.join(root, connectorId.replace(/[^A-Za-z0-9_-]/gu, "_"));
  const invoke = previewInvoker(broker, invocation, { updateCurrentTab: false });
  /** What each connector's files last held, to tell a session the profile renewed itself. */
  const written = new Map<string, string>();
  /** Slot values (digests) Scient's own reads rotated, verified in the profile: old to new. */
  const rotatedTo = new Map<string, string>();
  const fingerprint = (cookies: ReadonlyArray<{ readonly name: string; readonly value: string }>) =>
    NodeCrypto.createHash("sha256")
      .update(cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("\n"))
      .digest("hex");
  const browser = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(AgentInvocationContext, invocation),
      Effect.provideService(AccountsService, accounts),
      Effect.provideService(PreviewAutomationBroker, broker),
    );

  const snapshot = accounts.snapshot.pipe(Effect.orElseSucceed(() => undefined));

  const usable = Effect.fn("ConnectorSessions.usable")(function* (
    target: ConnectorSessionTarget,
    options: { readonly duringSignIn?: boolean } = {},
  ) {
    const current = yield* snapshot;
    const account = current?.accounts.find((row) => row.accountId === target.accountId);
    if (current === undefined || account === undefined)
      return yield* problem("needs-user", `The sign-in for ${hostOf(target.site)} was removed.`);
    if (account.details.kind !== "website" || !anySiteMatches(account.details.sites, target.site))
      return yield* problem(
        "needs-user",
        `${account.name} is not a sign-in for ${hostOf(target.site)}.`,
      );
    if (agentAccessOff(current.agentAccess, account.controls.access))
      return yield* problem(
        "needs-user",
        `${account.name} is turned off in Settings → Accounts & secrets.`,
      );
    if (target.projectId !== undefined && !inScope(account.controls.scope, target.projectId))
      return yield* problem("needs-user", `${account.name} is not available in this project.`);
    // A connector with no project uses only a sign-in for every project, checked at each use.
    if (target.projectId === undefined && account.controls.scope.type !== "all-projects")
      return yield* problem("needs-user", `${account.name} is kept to some projects.`);
    // A university's own sign-in service opens its mail and records too; it stays in the browser.
    if (isUniversitySignInService(current.accounts, target.site))
      return yield* problem("unavailable", "A university's sign-in service stays in the browser.");
    // A sign-in under way on the site is the person's until it ends.
    if (
      options.duringSignIn !== true &&
      (yield* accounts.attempts).some((attempt) => attempt.accountId === account.accountId)
    )
      return yield* problem(
        "needs-user",
        `You are signing in to ${hostOf(target.site)}. Try again when that finishes.`,
      );
    return account;
  });

  /** The browser's default profile, for a sign-in that names none. */
  const defaultProfileOf = invoke<PreviewAutomationStatus>("status", {}).pipe(
    Effect.map((status) => status.defaultProfileId ?? DEFAULT_BROWSER_PROFILE_ID),
  );
  const profileFor = (account: AccountSummary, defaultProfile: string) =>
    ("profileId" in account.details ? account.details.profileId : undefined) ?? defaultProfile;
  const profileOf = (account: AccountSummary) =>
    defaultProfileOf.pipe(Effect.map((defaultProfile) => profileFor(account, defaultProfile)));

  /** A tab nobody sees in the sign-in's profile (or `profileId`); the caller closes it. */
  const hiddenTab = Effect.fn("ConnectorSessions.hiddenTab")(function* (
    account: AccountSummary,
    profileId?: string,
  ) {
    const opened = yield* invoke<PreviewAutomationStatus>("open", {
      profileId: profileId ?? (yield* profileOf(account)),
      open: false,
      reuseExistingTab: false,
    });
    if (!opened.tabId) return yield* problem("unavailable", "No browser tab is available.");
    return opened.tabId;
  });

  const readCookies = Effect.fn("ConnectorSessions.readCookies")(function* (
    account: AccountSummary,
    site: string,
    profileId?: string,
  ) {
    const tabId = yield* hiddenTab(account, profileId);
    return yield* Effect.all({
      cookies: invoke<unknown>("accountCookies", { urls: [site] }, tabId).pipe(
        Effect.flatMap(decodeCookies),
      ),
      // Some sites tie a session to the browser that made it.
      userAgent: invoke<unknown>("evaluate", { expression: "navigator.userAgent" }, tabId).pipe(
        Effect.map((value) => (typeof value === "string" ? value : undefined)),
        Effect.orElseSucceed(() => undefined),
      ),
    }).pipe(Effect.ensuring(invoke("close", {}, tabId).pipe(Effect.ignore)));
  });

  const write = Effect.fn("ConnectorSessions.write")(function* (
    connectorId: string,
    site: string,
    { cookies, userAgent }: Effect.Success<ReturnType<typeof readCookies>>,
  ) {
    const folder = folderOf(connectorId);
    written.set(connectorId, fingerprint(cookies));
    return yield* Effect.tryPromise({
      try: async () => {
        await privateDirectory(root);
        await privateDirectory(folder);
        const json = await writePrivateFile(folder, "cookies.json", encodeCookies(cookies));
        const text = await writePrivateFile(folder, "cookies.txt", netscapeCookieJar(cookies));
        return {
          environment: {
            SCIENT_SIGN_IN_SITE: site,
            SCIENT_SIGN_IN_COOKIES: json,
            SCIENT_SIGN_IN_COOKIES_TXT: text,
            ...(userAgent === undefined || /[\r\n\0]/u.test(userAgent)
              ? {}
              : { SCIENT_SIGN_IN_USER_AGENT: userAgent }),
          },
          hide: cookies.map((cookie) => cookie.value).filter((value) => value.length >= MIN_HIDDEN),
        } satisfies PreparedConnectorSession;
      },
      catch: () => ({
        reason: "unavailable" as const,
        message: "Scient could not write the connector's session files.",
      }),
    });
  });

  /** Hands the session over only if the link still lets the connector use it, checked right now. */
  const publish = Effect.fn("ConnectorSessions.publish")(function* (
    target: ConnectorSessionTarget,
    session: Effect.Success<ReturnType<typeof readCookies>>,
  ) {
    yield* linkedUse(target);
    return yield* write(target.connectorId, target.site, session);
  });

  /** The connector's linked use of its sign-in; with `since`, only the row as it was read then. */
  const linkedGrant = (target: ConnectorSessionTarget, since?: AccountSummary) => ({
    scope: {
      projectId: target.projectId,
      unattended: true,
      ...(target.scheduledTaskId === undefined ? {} : { scheduledTaskId: target.scheduledTaskId }),
    },
    target: { type: "account" as const, accountId: target.accountId as AccountId },
    use: { origin: target.site, linked: true, ...(since === undefined ? {} : { since }) },
  });

  /** The grant, the row's version and no sign-out since `sequence`, in one locked step. */
  const stillStands = (target: ConnectorSessionTarget, row: AccountSummary, sequence: number) =>
    accounts.unlessSignedOutSince(row, sequence, Effect.void, linkedGrant(target, row)).pipe(
      Effect.catchTags({ AccountsError: (error) => problem("needs-user", error.message) }),
      Effect.flatMap((stands) =>
        stands
          ? Effect.void
          : problem(
              "needs-user",
              `You signed out of ${hostOf(target.site)}, so Scient discarded the answer.`,
            ),
      ),
    );

  const linkedUse = (target: ConnectorSessionTarget, since?: AccountSummary) => {
    const grant = linkedGrant(target, since);
    return accounts
      .authorizeUse(grant.scope, grant.target, grant.use)
      .pipe(Effect.catchTags({ AccountsError: (error) => problem("needs-user", error.message) }));
  };

  /**
   * A session Scient's own sign-in made is published under the accounts lock, only if no sign-out
   * landed since the sign-in began; none can land while it's written.
   */
  const publishUnlessSignedOut = Effect.fn("ConnectorSessions.publishUnlessSignedOut")(function* (
    account: AccountSummary,
    target: ConnectorSessionTarget,
    sequence: number,
    session: Effect.Success<ReturnType<typeof readCookies>>,
  ) {
    // Turned off or out of scope while Scient signed in: the session isn't handed over.
    yield* usable(target, { duringSignIn: true });
    yield* linkedUse(target);
    let written: Effect.Success<ReturnType<typeof write>> | undefined;
    const published = yield* accounts
      .unlessSignedOutSince(
        account,
        sequence,
        write(target.connectorId, target.site, session).pipe(
          Effect.map((result) => void (written = result)),
        ),
        // The grant too, in the same locked step as the fence.
        linkedGrant(target),
      )
      .pipe(Effect.catchTags({ AccountsError: (error) => problem("needs-user", error.message) }));
    if (!published || written === undefined)
      return yield* problem(
        "needs-user",
        `You signed out of ${hostOf(target.site)}, so Scient won't sign back in by itself.`,
      );
    return written;
  });

  /** Scient's own sign-in, in a hidden tab. Only a site that needs the person stops it. */
  const signIn = Effect.fn("ConnectorSessions.signIn")(function* (
    account: AccountSummary,
    target: ConnectorSessionTarget,
  ) {
    const result = yield* browser(
      guardedSignIn({
        signIn: account,
        caller: { kind: "connector", projectId: target.projectId },
      }),
    ).pipe(
      Effect.mapError((error): ConnectorSessionProblem => ({
        reason: "unavailable",
        message: error.message,
      })),
    );
    // A sign-in waiting at a code keeps its tab for the person; any other tab closes.
    if (result.tabId !== undefined && result.pending !== true)
      yield* invoke("close", {}, result.tabId).pipe(Effect.ignore);
    if (result.outcome === "signed-in") return;
    return yield* problem(
      result.outcome === "limited" ? "unavailable" : "needs-user",
      result.message ?? "The sign-in did not finish.",
    );
  });

  const browserProblem = (target: ConnectorSessionTarget) =>
    Effect.mapError(
      (error: ConnectorSessionProblem | { readonly message: string }): ConnectorSessionProblem =>
        "reason" in error
          ? error
          : {
              reason: "unavailable",
              message: `Scient could not reach ${hostOf(target.site)}'s session in its browser.`,
            },
    );

  const prepare = Effect.fn("ConnectorSessions.prepare")(function* (
    target: ConnectorSessionTarget,
  ) {
    const account = yield* usable(target);
    // The link and the run's pin first: nothing is read or signed in for a use they refuse.
    yield* linkedUse(target);
    let session = yield* readCookies(account, target.site).pipe(browserProblem(target));
    if (session.cookies.length === 0) {
      const sequence = yield* accounts.signOutSequence;
      yield* signIn(account, target);
      session = yield* readCookies(account, target.site).pipe(browserProblem(target));
      return yield* publishUnlessSignedOut(account, target, sequence, session);
    }
    return yield* publish(target, session);
  });

  const signInAgain = Effect.fn("ConnectorSessions.signInAgain")(function* (
    target: ConnectorSessionTarget,
  ) {
    const account = yield* usable(target);
    yield* linkedUse(target);
    // The person may have signed in since (or the site renewed the session): use that session.
    const current = yield* readCookies(account, target.site).pipe(browserProblem(target));
    const last = written.get(target.connectorId);
    if (current.cookies.length > 0 && last !== undefined && fingerprint(current.cookies) !== last)
      return yield* publish(target, current);
    const sequence = yield* accounts.signOutSequence;
    yield* signIn(account, target);
    const session = yield* readCookies(account, target.site).pipe(browserProblem(target));
    return yield* publishUnlessSignedOut(account, target, sequence, session);
  });

  const transport = options.transport ?? siteTransport;
  /** One write-back at a time per profile, from reading the slot to writing it back. */
  const writers = new Map<string, Semaphore.Semaphore>();
  const writerFor = (profileId: string) => {
    const existing = writers.get(profileId);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(1);
    writers.set(profileId, created);
    return created;
  };

  /**
   * Writes the decided slot back only while the link still allows it, no sign-in is under way,
   * no sign-out landed since `sequence`, and the slot still holds the value Scient sent.
   */
  const commitSlot = Effect.fn("ConnectorSessions.commitSlot")(function* (
    account: AccountSummary,
    target: ConnectorSessionTarget,
    sequence: number,
    sent: SessionCookie,
    next: SessionCookie | undefined,
    profileId: string,
  ) {
    const tabId = yield* hiddenTab(account, profileId);
    return yield* Effect.gen(function* () {
      yield* usable(target);
      let outcome: string | undefined;
      const write = Effect.suspend(() =>
        invoke<{ readonly outcome: string }>(
          "accountWriteCookie",
          {
            url: `${target.site}${sent.path}`,
            name: sent.name,
            path: sent.path,
            expected: cookieValueDigest(sent.value),
            sameSite: sent.sameSite,
            ...(next === undefined ? {} : { cookie: next }),
          },
          tabId,
        ),
      ).pipe(Effect.map((written) => void (outcome = written.outcome)));
      // The grant, the row's version and the sign-out fence, in one locked step with the write.
      const ran = yield* accounts
        .unlessSignedOutSince(account, sequence, write, linkedGrant(target, account))
        .pipe(Effect.catchTags({ AccountsError: () => Effect.succeed(false) }));
      if (!ran) return "fenced" as const;
      if (outcome === "written" && next !== undefined)
        rotatedTo.set(cookieValueDigest(sent.value), cookieValueDigest(next.value));
      if (outcome === "written")
        return next === undefined ? ("deleted" as const) : ("rotated" as const);
      return outcome === "lost" ? ("lost" as const) : ("newer" as const);
    }).pipe(Effect.ensuring(invoke("close", {}, tabId).pipe(Effect.ignore)));
  });

  const readWithWebsiteSession = Effect.fn("ConnectorSessions.readWithWebsiteSession")(function* (
    target: ConnectorSessionTarget,
    slot: WriteBackSlot | undefined,
    url: string,
  ) {
    const site = new URL(target.site);
    const read = URL.canParse(url) ? new URL(url) : undefined;
    if (read === undefined || read.origin !== site.origin)
      return yield* problem("unavailable", `Scient reads only ${hostOf(target.site)} itself.`);
    const account = yield* usable(target);
    yield* linkedUse(target);
    // One profile for the whole read: its cookies, its check and its write-back.
    const defaultProfile = yield* defaultProfileOf.pipe(browserProblem(target));
    const profileId = profileFor(account, defaultProfile);
    const result = yield* writerFor(profileId).withPermits(1)(
      Effect.gen(function* () {
        // The fence first: a sign-out from here on discards whatever this read brings back.
        const sequence = yield* accounts.signOutSequence;
        // The cookies this very request carries, a slot at a deeper path included.
        const session = yield* readCookies(account, read.href, profileId).pipe(
          browserProblem(target),
        );
        const sent =
          slot === undefined
            ? undefined
            : session.cookies.find((cookie) =>
                isWriteBackSlot(cookie, site, slot.cookie, slot.path),
              );
        // No session cookie, nothing to send: the connector's sign-in recovery takes it from here.
        if (slot !== undefined && sent === undefined)
          return { outcome: "signed-out", kept: "unchanged" } as const;
        // Only a cookie this request carries may come back changed.
        if (
          sent !== undefined &&
          cookieHeaderFor([sent], read, (yield* Clock.currentTimeMillis) / 1000) === ""
        )
          return yield* problem(
            "unavailable",
            `${hostOf(target.site)}'s session cookie isn't sent to ${read.pathname}: its path doesn't cover it.`,
          );
        // Right before sending: the row as it is now, in the profile its cookies came from,
        // still allowed, and no sign-out since the fence, in one locked step.
        const current = yield* usable(target);
        if (profileFor(current, defaultProfile) !== profileId)
          return yield* problem("needs-user", `${current.name} moved to another browser profile.`);
        yield* stillStands(target, current, sequence);
        const nowSeconds = (yield* Clock.currentTimeMillis) / 1000;
        const answer = yield* Effect.promise((signal) =>
          readSite(
            transport,
            read,
            {
              cookie: cookieHeaderFor(session.cookies, read, nowSeconds),
              userAgent: session.userAgent,
            },
            signal,
          ),
        );
        if (answer === "too-large")
          return yield* problem("unavailable", `${hostOf(target.site)} sent more than 4 MB.`);
        if (answer === undefined) return { outcome: "unreachable", kept: "unchanged" } as const;
        // Nothing the site sent goes on once the grant, the row or a sign-out changed meanwhile.
        yield* stillStands(target, current, sequence);
        const outcome = readOutcome(read, answer);
        const decision =
          sent === undefined
            ? ({ type: "none" } as const)
            : decideWriteBack({
                slot: sent,
                url: read,
                headers: answer.setCookies,
                receivedAtSeconds: (yield* Clock.currentTimeMillis) / 1000,
                signedOut: outcome === "signed-out",
              });
        const kept =
          sent === undefined || decision.type === "none"
            ? ("unchanged" as const)
            : decision.type === "refused"
              ? ("refused" as const)
              : yield* commitSlot(
                  current,
                  target,
                  sequence,
                  sent,
                  decision.type === "rotate" ? decision.cookie : undefined,
                  profileId,
                ).pipe(browserProblem(target));
        // A sign-out that won the commit withholds the answer too.
        if (kept === "fenced")
          return yield* problem(
            "needs-user",
            `You signed out of ${hostOf(target.site)}, so Scient discarded the answer.`,
          );
        return {
          outcome,
          status: answer.status,
          contentType: answer.contentType,
          ...(answer.body === undefined ? {} : { body: answer.body }),
          ...(answer.location === undefined ? {} : { location: answer.location }),
          kept,
        } satisfies WebsiteReadResult;
      }),
    );
    yield* accounts
      .recordUse({
        target: { type: "account", accountId: account.accountId },
        action: "request",
        outcome: result.outcome === "ok" ? "ok" : "error",
        detail: `GET ${site.host}`,
        ...(target.projectId === undefined ? {} : { projectId: target.projectId }),
      })
      .pipe(Effect.ignore);
    return result;
  });

  /**
   * Which session the profile holds for the site: a digest of its cookies but the rotating slot,
   * and the slot's own value digest.
   */
  const sessionDigest = (
    target: ConnectorSessionTarget,
    account: AccountSummary,
    slot: WriteBackSlot | undefined,
    url: string,
  ) =>
    readCookies(account, url).pipe(
      browserProblem(target),
      Effect.map((session) => {
        const isSlot = (cookie: SessionCookie) =>
          slot !== undefined &&
          isWriteBackSlot(cookie, new URL(target.site), slot.cookie, slot.path);
        const kept = session.cookies.find(isSlot);
        return {
          cookies: fingerprint(
            session.cookies
              .filter((cookie) => !isSlot(cookie))
              .toSorted((a, b) => `${a.name}=${a.value}`.localeCompare(`${b.name}=${b.value}`)),
          ),
          ...(kept === undefined ? {} : { slot: cookieValueDigest(kept.value) }),
        };
      }),
    );
  /** The slot's value now is the one at the mark, or one Scient's own reads rotated it to since. */
  const rotatedFrom = (from: string | undefined, now: string | undefined) => {
    let at = from;
    for (let step = 0; step <= rotatedTo.size; step++) {
      if (at === now) return true;
      at = at === undefined ? undefined : rotatedTo.get(at);
      if (at === undefined) return false;
    }
    return false;
  };

  return {
    accountsFor: (site) =>
      Effect.map(snapshot, (current) =>
        (current?.accounts ?? []).filter(
          (account) =>
            account.details.kind === "website" && anySiteMatches(account.details.sites, site),
        ),
      ),
    account: (accountId) =>
      Effect.map(snapshot, (current) =>
        current?.accounts.find((row) => row.accountId === (accountId as AccountId)),
      ),
    prepare,
    signInAgain,
    allowed: (target) =>
      usable(target, { duringSignIn: true }).pipe(
        Effect.andThen(linkedUse(target)),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
    remove: (connectorId) =>
      Effect.promise(async () => {
        written.delete(connectorId);
        await NodeFSP.rm(folderOf(connectorId), { recursive: true, force: true }).catch(
          () => undefined,
        );
      }),
    readWithWebsiteSession,
    sessionMark: Effect.fn("ConnectorSessions.sessionMark")(function* (target, slot, url) {
      const account = yield* usable(target);
      yield* linkedUse(target);
      const sequence = yield* accounts.signOutSequence;
      return {
        sequence,
        url,
        ...(yield* sessionDigest(target, account, slot, url)),
      } satisfies SessionMark;
    }),
    sessionStands: Effect.fn("ConnectorSessions.sessionStands")(
      function* (target, slot, mark) {
        const account = yield* usable(target);
        yield* stillStands(target, account, mark.sequence);
        const now = yield* sessionDigest(target, account, slot, mark.url);
        // A sign-out or a withdrawn link while the jar was read counts too.
        yield* stillStands(target, account, mark.sequence);
        // The slot alone can be a new session: only a rotation Scient saw land keeps it the same.
        return now.cookies === mark.cookies && rotatedFrom(mark.slot, now.slot)
          ? ("stands" as const)
          : ("changed" as const);
      },
      Effect.orElseSucceed(() => "refused" as const),
    ),
  } satisfies ConnectorSessionsShape;
});
