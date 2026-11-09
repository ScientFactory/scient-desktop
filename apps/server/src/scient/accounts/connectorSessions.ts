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
  ThreadId,
} from "@t3tools/contracts";
import { anySiteMatches } from "@t3tools/shared/scientSiteMatch";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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

const decodeCookies = Schema.decodeUnknownEffect(AccountCookies);
const encodeCookies = Schema.encodeSync(Schema.fromJsonString(AccountCookies));

/** Connectors' sign-ins are no agent's run: they act under their own identity. */
const CONNECTOR_THREAD = ThreadId.make("scient-connector-sessions");
/** Values shorter than this are not worth hiding; they would mangle ordinary words. */
const MIN_HIDDEN = 8;

export interface ConnectorSessionTarget {
  readonly connectorId: string;
  readonly accountId: string;
  /** The manifest's `signIn` site, as an https origin. */
  readonly site: string;
  readonly projectId?: ProjectId | undefined;
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
  readonly remove: (connectorId: string) => Effect.Effect<void>;
}

const problem = (reason: ConnectorSessionProblem["reason"], message: string) =>
  Effect.fail<ConnectorSessionProblem>({ reason, message });

const hostOf = (site: string) => (URL.canParse(site) ? new URL(site).host : site);

export const needsYouMessage = (site: string) =>
  `${hostOf(site)} needs you to sign in: open Settings → Accounts, or the connector's page in Settings → Extensions.`;

export const makeConnectorSessions = Effect.fn("ConnectorSessions.make")(function* (options: {
  readonly secretsDir: string;
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

  const usable = Effect.fn("ConnectorSessions.usable")(function* (target: ConnectorSessionTarget) {
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
    // A university's own sign-in service opens its mail and records too; it stays in the browser.
    if (isUniversitySignInService(current.accounts, target.site))
      return yield* problem("unavailable", "A university's sign-in service stays in the browser.");
    // A sign-in under way on the site is the person's until it ends.
    if ((yield* accounts.attempts).some((attempt) => attempt.accountId === account.accountId))
      return yield* problem(
        "needs-user",
        `You are signing in to ${hostOf(target.site)}. Try again when that finishes.`,
      );
    return account;
  });

  const readCookies = Effect.fn("ConnectorSessions.readCookies")(function* (
    account: AccountSummary,
    site: string,
  ) {
    const status = yield* invoke<PreviewAutomationStatus>("status", {});
    const profileId =
      ("profileId" in account.details ? account.details.profileId : undefined) ??
      status.defaultProfileId ??
      DEFAULT_BROWSER_PROFILE_ID;
    const opened = yield* invoke<PreviewAutomationStatus>("open", {
      profileId,
      open: false,
      reuseExistingTab: false,
    });
    const tabId = opened.tabId;
    if (!tabId) return yield* problem("unavailable", "No browser tab is available.");
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

  /** Scient's own sign-in, in a hidden tab. Only a site that needs the person stops it. */
  const signIn = Effect.fn("ConnectorSessions.signIn")(function* (account: AccountSummary) {
    const result = yield* browser(
      guardedSignIn({ signIn: account, caller: { kind: "connector" } }),
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
    let session = yield* readCookies(account, target.site).pipe(browserProblem(target));
    if (session.cookies.length === 0) {
      yield* signIn(account);
      session = yield* readCookies(account, target.site).pipe(browserProblem(target));
    }
    return yield* write(target.connectorId, target.site, session);
  });

  const signInAgain = Effect.fn("ConnectorSessions.signInAgain")(function* (
    target: ConnectorSessionTarget,
  ) {
    const account = yield* usable(target);
    // The person may have signed in since (or the site renewed the session): use that session.
    const current = yield* readCookies(account, target.site).pipe(browserProblem(target));
    const last = written.get(target.connectorId);
    if (current.cookies.length > 0 && last !== undefined && fingerprint(current.cookies) !== last)
      return yield* write(target.connectorId, target.site, current);
    yield* signIn(account);
    const session = yield* readCookies(account, target.site).pipe(browserProblem(target));
    return yield* write(target.connectorId, target.site, session);
  });

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
    remove: (connectorId) =>
      Effect.promise(() => {
        written.delete(connectorId);
        return;
        NodeFSP.rm(folderOf(connectorId), { recursive: true, force: true }).catch(() => undefined);
      }),
  } satisfies ConnectorSessionsShape;
});
