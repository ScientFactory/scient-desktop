import {
  AccountPageOffer,
  AccountSetupPage,
  BrowserProfileId,
  BrowserImportSourceId,
  ProfileOperationId,
  DEFAULT_BROWSER_PROFILE_ID,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  EnvironmentId,
  DesktopPreviewTabInputSchema,
  type DesktopCapturedSignIn,
} from "@t3tools/contracts";
import * as Electron from "electron";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { readBrowserPasswords } from "./browserPasswords.ts";
import { inJarTurn } from "./jarTurns.ts";
import { importPasswordsHere, writeCheckFor } from "./ownBackend.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DesktopIpc, type DesktopIpcInvokeEvent } from "../../ipc/DesktopIpc.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { appWindowForSender } from "../multiWindow/appWindows.ts";
import { PreviewManager } from "../../preview/Manager.ts";
import { safeHttpOrigin } from "../../preview/FaviconCapture.ts";
import { resolvePartitionScope } from "../../ipc/methods/preview.ts";
import { discoverSourceProfiles } from "./sourceProfiles.ts";
import { BROWSER_IMPORT_SOURCES, sourcePathContext } from "../../preview/BrowserImport/Sources.ts";
import { throughBrowserIsOn } from "./browserConnectionImport.ts";
import { makeSiteIcons } from "./siteIcons.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { groupSignedInSites } from "./signedInSites.ts";
import {
  FillMainInput,
  ReadSessionsInput,
  fillMain,
  readSessions,
  removeSiteCookies,
  signOutMainSite,
  startAfresh,
  underMainLock,
  WithdrawMainInput,
  withdrawFromMain,
} from "./mainFill.ts";
import {
  documentFailedScript,
  documentIdScript,
  loginFillScript,
  loginFormReportScript,
  pageLimitedScript,
  pageSecretsScript,
  PRELOAD_WORLD_ID,
  signInPageStateScript,
  staySignedInScript,
  submitPageLookScript,
} from "./loginFields.ts";
import { walkToPasswordPage, type WalkTab } from "./passwordPageWalk.ts";
import { passwordPageScript } from "@t3tools/shared/scientSetupPage";
import { pageSealKey, sealPageSecrets } from "@t3tools/shared/scientPageSeal";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import { watchBeforeRequest } from "../../preview/sessionBeforeRequest.ts";
import {
  armFill,
  submitAnswer,
  submitSeen,
  type SubmitLook,
  type SubmitTab,
} from "./submitAnswers.ts";
import {
  ChromeSignInInput,
  chromeSignIn,
  chromeSignInBrowser,
  endChromeSignIn,
  signInFolder,
  type SignInHost,
} from "./chromeSignIn.ts";
import { forgetSignInWindow, WINDOW_SIZE } from "./chromeWindow.ts";
import { accountsSessionIdentity } from "./sessionIdentity.ts";
import {
  copyProfileCookies,
  undoProfileCopy,
  signOutSiteKept,
  loadProfileGenerations,
  restoreSignOutCookies,
  setProfileGenerations,
  setSaveDeadlines,
  sweepSignOutSaves,
} from "./profileData.ts";
import { siteCookieRemovals } from "./signedInSites.ts";
import { withCookieDebugger } from "./sessionCookies.ts";
import { undoEncryption } from "./protectedStore.ts";
import { cookieDigest } from "./cookieDigest.ts";
import { DesktopAccountsError } from "./errors.ts";
import { accountsOwner } from "./accountsOwner.ts";
import { onGoogleActivity, readGoogleSessions } from "./googleSessions.ts";
import { isPublicHttps, quietVisit } from "./quietVisit.ts";
import * as Channels from "./protocol.ts";
import { appBundleOf, askForMessages, FULL_DISK_ACCESS_URL } from "./fullDiskAccess.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";

const Value = Schema.String.check(Schema.isMaxLength(65_536));
const Fill = Schema.Struct({
  tabId: DesktopPreviewTabInputSchema.fields.tabId,
  expectedOrigin: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  username: Schema.optional(Value),
  otherUsername: Schema.optional(Value),
  password: Schema.optional(Value),
  otp: Schema.optional(Value),
  otpExpected: Schema.optional(Schema.String.check(Schema.isMaxLength(16))),
  passwordExpected: Schema.optional(Value),
  newPassword: Schema.optional(Value),
  documentId: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  automatic: Schema.optional(Schema.Boolean),
  submit: Schema.optional(Schema.Boolean),
});
const Sites = Schema.Struct({
  profileId: BrowserProfileId,
  environmentId: Schema.optional(EnvironmentId),
  /** Round 6d: the data an operation was done in, and its destination's; its writes go there. */
  generation: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  intoGeneration: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
const Capture = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2048)),
  path: Schema.String.check(Schema.isMaxLength(2048)),
  step: Schema.Literals(["password", "username"]),
  username: Value,
  password: Value,
  newPassword: Schema.optional(Value),
});

const decodeFill = Schema.decodeUnknownOption(Fill);
const decodeSites = Schema.decodeUnknownOption(Sites);
const SignOut = Schema.Struct({
  ...Sites.fields,
  site: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253)),
});
const decodeSignOut = Schema.decodeUnknownOption(SignOut);
const decodeQuietVisit = Schema.decodeUnknownOption(
  Schema.Struct({
    ...Sites.fields,
    url: Schema.String.check(Schema.isMaxLength(2048), Schema.isPattern(/^https:\/\//)),
  }),
);
const decodeCapture = Schema.decodeUnknownOption(Capture);

type AccountsInvokeEvent = DesktopIpcInvokeEvent & { readonly senderFrame?: unknown };

const appWindowSender = Effect.fn("DesktopAccounts.appWindowSender")(function* (
  event?: AccountsInvokeEvent,
) {
  const sender = yield* appWindowForSender(yield* ElectronWindow, event?.sender.id);
  return (
    event !== undefined &&
    Option.isSome(sender) &&
    "senderFrame" in event &&
    event.senderFrame === sender.value.webContents.mainFrame
  );
});

const unavailable = () => new DesktopAccountsError({});

export const fill = Effect.fn("DesktopAccounts.fill")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return false;
  const input = decodeFill(raw);
  if (Option.isNone(input)) return false;
  const manager = yield* PreviewManager;
  return yield* Effect.gen(function* () {
    const contents = yield* manager.accountsWebContents(input.value.tabId);
    if (contents.isDestroyed() || contents.getType() !== "webview") return false;
    if (input.value.automatic && accountsSessionIdentity(contents.session)?.persistent !== true)
      return false;
    const origin = safeHttpOrigin(contents.getURL());
    if (
      origin === null ||
      (input.value.expectedOrigin !== undefined && input.value.expectedOrigin !== origin)
    )
      return false;
    // A saved password typed into a sign-in form: its submit's own request is watched for from
    // before the fill, since the fill may submit the form itself.
    const { newPassword, password, documentId } = input.value;
    if (newPassword === undefined && password !== undefined && documentId !== undefined)
      armFill(
        submitTab(contents),
        contents.session,
        (urls, look) => watchBeforeRequest(contents.session, urls, look),
        { origin, documentId, password },
      );
    const filled = yield* Effect.tryPromise({
      try: () =>
        contents
          .executeJavaScriptInIsolatedWorld(PRELOAD_WORLD_ID, [
            { code: loginFillScript(input.value, origin, input.value) },
          ])
          .then((result: unknown) => {
            const filled =
              result === true || result === "submitted" ? (result as true | "submitted") : false;
            if (filled && input.value.password !== undefined)
              answerStaySignedInNext(contents, origin);
            return filled;
          }),
      catch: unavailable,
    });
    // A new password the desktop typed: its own request is watched for from now on.
    if (filled && newPassword !== undefined && documentId !== undefined)
      armFill(
        submitTab(contents),
        contents.session,
        (urls, look) => watchBeforeRequest(contents.session, urls, look),
        { origin, documentId, password: newPassword },
      );
    return filled;
  }).pipe(Effect.orElseSucceed(() => false));
});

/** How long after a fill Microsoft's "Stay signed in?" counts as that sign-in's next step. */
const STAY_SIGNED_IN_WINDOW_MS = 120_000;

/** The page loads that follow a password Scient filled: the first "Stay signed in?" gets Yes. */
const answerStaySignedInNext = (contents: Electron.WebContents, origin: string) => {
  const stop = () => {
    clearTimeout(expiry);
    if (!contents.isDestroyed()) contents.removeListener("did-finish-load", onLoad);
  };
  const onLoad = () => {
    if (contents.isDestroyed()) return stop();
    void contents
      .executeJavaScriptInIsolatedWorld(PRELOAD_WORLD_ID, [{ code: staySignedInScript(origin) }])
      .then(
        (answered: unknown) => answered === true && stop(),
        () => undefined,
      );
  };
  // @effect-diagnostics-next-line globalTimers:off -- Electron's page events run outside Effect.
  const expiry = setTimeout(stop, STAY_SIGNED_IN_WINDOW_MS);
  expiry.unref?.();
  contents.on("did-finish-load", onLoad);
};

export const signedInSites = Effect.fn("DesktopAccounts.signedInSites")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return [];
  const input = decodeSites(raw);
  if (Option.isNone(input)) return [];
  const manager = yield* PreviewManager;
  const scope = resolvePartitionScope(
    input.value.environmentId ?? PRIMARY_LOCAL_ENVIRONMENT_ID,
    input.value.profileId,
  );
  return yield* manager.getBrowserSession(scope.scope, scope.persistent, scope.namespace).pipe(
    Effect.flatMap((session) =>
      Effect.tryPromise({ try: () => session.cookies.get({}), catch: unavailable }),
    ),
    Effect.map((cookies) =>
      groupSignedInSites(
        cookies.flatMap((cookie) =>
          cookie.domain === undefined ? [] : [{ domain: cookie.domain }],
        ),
      ),
    ),
    Effect.orElseSucceed(() => []),
  );
});

const visitQuietly = Effect.fn("DesktopAccounts.visitQuietly")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return null;
  const input = decodeQuietVisit(raw);
  if (Option.isNone(input) || !isPublicHttps(input.value.url)) return null;
  const manager = yield* PreviewManager;
  const scope = resolvePartitionScope(
    input.value.environmentId ?? PRIMARY_LOCAL_ENVIRONMENT_ID,
    input.value.profileId,
  );
  return yield* manager.getBrowserSession(scope.scope, scope.persistent, scope.namespace).pipe(
    Effect.flatMap((session) =>
      Effect.tryPromise({
        try: () =>
          quietVisit(
            (url) =>
              Electron.net.request({
                url,
                session,
                credentials: "include",
                useSessionCookies: true,
                redirect: "manual",
              }),
            input.value.url,
          ),
        catch: unavailable,
      }),
    ),
    Effect.orElseSucceed(() => null),
  );
});

const googleSessions = Effect.fn("DesktopAccounts.googleSessions")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return null;
  const input = decodeSites(raw);
  if (Option.isNone(input)) return null;
  const manager = yield* PreviewManager;
  const scope = resolvePartitionScope(
    input.value.environmentId ?? PRIMARY_LOCAL_ENVIRONMENT_ID,
    input.value.profileId,
  );
  return yield* manager.getBrowserSession(scope.scope, scope.persistent, scope.namespace).pipe(
    Effect.flatMap((session) =>
      Effect.tryPromise({ try: () => readGoogleSessions(session), catch: unavailable }),
    ),
    Effect.orElseSucceed(() => null),
  );
});

export const cookieMetadata = Effect.fn("DesktopAccounts.cookieMetadata")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return null;
  const input = decodeSites(raw);
  if (Option.isNone(input)) return null;
  const manager = yield* PreviewManager;
  const scope = resolvePartitionScope(
    input.value.environmentId ?? PRIMARY_LOCAL_ENVIRONMENT_ID,
    input.value.profileId,
  );
  return yield* manager.getBrowserSession(scope.scope, scope.persistent, scope.namespace).pipe(
    Effect.flatMap((session) =>
      Effect.tryPromise({ try: () => session.cookies.get({}), catch: unavailable }),
    ),
    Effect.map((cookies) =>
      cookies.flatMap((cookie) =>
        cookie.domain === undefined
          ? []
          : [
              {
                domain: cookie.domain,
                httpOnly: cookie.httpOnly === true,
                ...(cookie.expirationDate === undefined ? {} : { expires: cookie.expirationDate }),
                name: cookie.name,
                path: cookie.path ?? "/",
                digest: cookieDigest(cookie.value),
              },
            ],
      ),
    ),
    Effect.orElseSucceed(() => null),
  );
});

const signOutSite = Effect.fn("DesktopAccounts.signOutSite")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return false;
  const input = decodeSignOut(raw);
  if (Option.isNone(input)) return false;
  const manager = yield* PreviewManager;
  const scope = resolvePartitionScope(
    input.value.environmentId ?? PRIMARY_LOCAL_ENVIRONMENT_ID,
    input.value.profileId,
  );
  return yield* manager.getBrowserSession(scope.scope, scope.persistent, scope.namespace).pipe(
    Effect.flatMap((session) =>
      Effect.tryPromise({
        try: () => removeSiteCookies(session, input.value.site),
        catch: unavailable,
      }),
    ),
    Effect.orElseSucceed(() => false),
  );
});

// Round 6b: Clear's generations, a sign-out kept for Undo, and the purge after the hour.
const decodeGenerations = Schema.decodeUnknownOption(
  Schema.Struct({
    environmentId: Schema.optional(EnvironmentId),
    generations: Schema.Record(Schema.String, Schema.Int),
  }),
);
const profileGenerations = Effect.fn("DesktopAccounts.profileGenerations")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return false;
  const input = decodeGenerations(raw);
  if (Option.isNone(input)) return false;
  return setProfileGenerations(
    input.value.environmentId ?? PRIMARY_LOCAL_ENVIRONMENT_ID,
    input.value.generations,
  );
});
// Round 6e: Undo saves go by their receipts' deadlines, never by their age.
const decodeDeadlines = Schema.decodeUnknownOption(
  Schema.Struct({
    deadlines: Schema.Record(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
      Schema.NullOr(Schema.String.check(Schema.isMaxLength(40))),
    ),
  }),
);
export const undoDeadlines = Effect.fn("DesktopAccounts.undoDeadlines")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return false;
  const input = decodeDeadlines(raw);
  if (Option.isNone(input)) return false;
  const entries = Object.entries(input.value.deadlines).slice(0, 1000);
  const deadlines: Record<string, number | null> = {};
  for (const [operationId, until] of entries) {
    const ms = until === null ? null : Date.parse(until);
    if (ms === null || Number.isFinite(ms)) deadlines[operationId] = ms;
  }
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const now = yield* Clock.currentTimeMillis;
  return yield* Effect.try({
    try: () => {
      setSaveDeadlines(environment.stateDir, deadlines, now);
      return true;
    },
    catch: () => new DesktopAccountsError({}),
  }).pipe(Effect.orElseSucceed(() => false));
});
const decodeKeptSignOut = Schema.decodeUnknownOption(
  Schema.Struct({
    ...SignOut.fields,
    operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  }),
);
const profileSession = Effect.fn("DesktopAccounts.profileSession")(function* (
  environmentId: string | undefined,
  profileId: string,
  generation?: number,
) {
  const manager = yield* PreviewManager;
  const scope = resolvePartitionScope(
    environmentId ?? PRIMARY_LOCAL_ENVIRONMENT_ID,
    profileId,
    ...(generation === undefined ? [] : [generation]),
  );
  return yield* manager.getBrowserSession(scope.scope, scope.persistent, scope.namespace);
});
const encryption = undoEncryption;

/** Sign-out with Undo: the site's cookies are kept, encrypted, for the hour, then removed. */
/** Whether a cookie is one a site's sign-out removes, as Sign out decides it. */
const inSiteOf = (cookie: { readonly domain: string }, site: string) =>
  siteCookieRemovals([{ ...cookie, name: "" }], site).length > 0;
export const signOutKept = Effect.fn("DesktopAccounts.signOutKept")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return null;
  const input = decodeKeptSignOut(raw);
  if (Option.isNone(input)) return null;
  const { environmentId, profileId, site, operationId } = input.value;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const mayWrite = yield* writeCheckFor(environmentId, operationId, "do");
  return yield* profileSession(environmentId, profileId, input.value.generation).pipe(
    Effect.flatMap((session) =>
      Effect.tryPromise({
        try: () => {
          // Through the partition's CDP: partitioned cookies are signed out and kept too.
          const signOut = () =>
            inJarTurn([session], () =>
              withCookieDebugger(session, (send) =>
                signOutSiteKept({
                  stateDir: environment.stateDir,
                  operationId,
                  send,
                  site,
                  inSite: inSiteOf,
                  encrypt: encryption()?.encrypt,
                  ...(mayWrite ? { mayWrite } : {}),
                }),
              ),
            );
          // Main's under the lock it shares with every copy into it, and starts the site afresh.
          return profileId === DEFAULT_BROWSER_PROFILE_ID
            ? underMainLock(environmentId ?? PRIMARY_LOCAL_ENVIRONMENT_ID, async () => {
                const done = await signOut();
                startAfresh(session, site);
                return done;
              })
            : signOut();
        },
        catch: unavailable,
      }),
    ),
    Effect.orElseSucceed(() => null),
  );
});
const decodeRestore = Schema.decodeUnknownOption(
  Schema.Struct({
    ...Sites.fields,
    operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  }),
);
const restoreSignOut = Effect.fn("DesktopAccounts.restoreSignOut")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return null;
  const input = decodeRestore(raw);
  const crypto = encryption();
  if (Option.isNone(input) || !crypto) return null;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const mayWrite = yield* writeCheckFor(input.value.environmentId, input.value.operationId, "undo");
  return yield* profileSession(
    input.value.environmentId,
    input.value.profileId,
    input.value.generation,
  ).pipe(
    Effect.flatMap((session) =>
      Effect.tryPromise({
        try: () => {
          const restore = () =>
            inJarTurn([session], () =>
              withCookieDebugger(session, (send) =>
                restoreSignOutCookies(
                  environment.stateDir,
                  input.value.operationId,
                  send,
                  crypto.decrypt,
                  mayWrite,
                ),
              ),
            );
          // Main's, under the lock it shares with every copy into it.
          return input.value.profileId === DEFAULT_BROWSER_PROFILE_ID
            ? underMainLock(input.value.environmentId ?? PRIMARY_LOCAL_ENVIRONMENT_ID, restore)
            : restore();
        },
        catch: unavailable,
      }),
    ),
    Effect.orElseSucceed(() => null),
  );
});
const decodePurge = Schema.decodeUnknownOption(
  Schema.Struct({ ...Sites.fields, generation: Schema.Int }),
);
/** A generation Clear or Remove left, once its Undo hour is over: emptied for good. */
const purgeProfileData = Effect.fn("DesktopAccounts.purgeProfileData")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return false;
  const input = decodePurge(raw);
  if (Option.isNone(input)) return false;
  return yield* profileSession(
    input.value.environmentId,
    input.value.profileId,
    input.value.generation,
  ).pipe(
    Effect.flatMap((session) =>
      Effect.tryPromise({
        try: async () => {
          await session.clearStorageData();
          await session.clearCache();
          return true;
        },
        catch: unavailable,
      }),
    ),
    Effect.orElseSucceed(() => false),
  );
});

const decodeCopy = Schema.decodeUnknownOption(
  Schema.Struct({
    ...Sites.fields,
    into: BrowserProfileId,
    sites: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(253)))),
    move: Schema.optional(Schema.Boolean),
    operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  }),
);
/** Copy, move and merge between two of this desktop's partitions (round 6b). */
const copyProfileSites = Effect.fn("DesktopAccounts.copyProfileSites")(
  function* (raw: unknown, event?: AccountsInvokeEvent) {
    if (!(yield* appWindowSender(event))) return null;
    const input = decodeCopy(raw);
    if (Option.isNone(input)) return null;
    const { environmentId, profileId, into, sites, move, operationId } = input.value;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const from = yield* profileSession(environmentId, profileId, input.value.generation);
    const to = yield* profileSession(environmentId, into, input.value.intoGeneration);
    const mayWrite = yield* writeCheckFor(environmentId, operationId, "do");
    return yield* Effect.tryPromise({
      // Each partition through its own CDP: Electron's cookie API can't name a partition.
      try: () =>
        inJarTurn([from, to], () =>
          withCookieDebugger(from, (fromSend) =>
            withCookieDebugger(to, (intoSend) =>
              copyProfileCookies({
                stateDir: environment.stateDir,
                operationId,
                from: fromSend,
                into: intoSend,
                sites,
                inSite: inSiteOf,
                move: move === true,
                crypto: encryption(),
                ...(mayWrite ? { mayWrite } : {}),
              }),
            ),
          ),
        ),
      catch: unavailable,
    }).pipe(Effect.orElseSucceed(() => null));
  },
  Effect.orElseSucceed(() => null),
);
const decodeUndoCopy = Schema.decodeUnknownOption(
  Schema.Struct({
    ...Sites.fields,
    into: BrowserProfileId,
    operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  }),
);
const undoProfileCopyHandler = Effect.fn("DesktopAccounts.undoProfileCopy")(
  function* (raw: unknown, event?: AccountsInvokeEvent) {
    if (!(yield* appWindowSender(event))) return null;
    const input = decodeUndoCopy(raw);
    const crypto = encryption();
    if (Option.isNone(input) || !crypto) return null;
    const { environmentId, profileId, into, operationId } = input.value;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const from = yield* profileSession(environmentId, profileId, input.value.generation);
    const to = yield* profileSession(environmentId, into, input.value.intoGeneration);
    const mayWrite = yield* writeCheckFor(environmentId, operationId, "undo");
    return yield* Effect.tryPromise({
      try: () =>
        inJarTurn([from, to], () =>
          withCookieDebugger(from, (fromSend) =>
            withCookieDebugger(to, (intoSend) =>
              undoProfileCopy({
                stateDir: environment.stateDir,
                operationId,
                from: fromSend,
                into: intoSend,
                decrypt: crypto.decrypt,
                ...(mayWrite ? { mayWrite } : {}),
              }),
            ),
          ),
        ),
      catch: unavailable,
    }).pipe(Effect.orElseSucceed(() => null));
  },
  Effect.orElseSucceed(() => null),
);

const decodeFillMain = Schema.decodeUnknownOption(FillMainInput);
export const fillMainHandler = Effect.fn("DesktopAccounts.fillMainHandler")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return null;
  const input = decodeFillMain(raw);
  if (Option.isNone(input)) return null;
  const { operationId } = input.value;
  return yield* fillMain(
    input.value,
    operationId === undefined
      ? undefined
      : yield* writeCheckFor(input.value.environmentId, operationId, "do"),
  );
});

const decodeReadSessions = Schema.decodeUnknownOption(ReadSessionsInput);
const readSessionsHandler = Effect.fn("DesktopAccounts.readSessionsHandler")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return null;
  const input = decodeReadSessions(raw);
  if (Option.isNone(input)) return null;
  return yield* readSessions(input.value);
});

const decodeSignOutMain = Schema.decodeUnknownOption(
  Schema.Struct({ site: SignOut.fields.site, environmentId: Schema.optional(EnvironmentId) }),
);
const signOutMainHandler = Effect.fn("DesktopAccounts.signOutMainHandler")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return false;
  const input = decodeSignOutMain(raw);
  if (Option.isNone(input)) return false;
  return yield* signOutMainSite(
    input.value.site,
    input.value.environmentId ?? PRIMARY_LOCAL_ENVIRONMENT_ID,
  ).pipe(Effect.orElseSucceed(() => false));
});

const decodeWithdrawMain = Schema.decodeUnknownOption(WithdrawMainInput);
export const withdrawFromMainHandler = Effect.fn("DesktopAccounts.withdrawFromMainHandler")(
  function* (raw: unknown, event?: AccountsInvokeEvent) {
    if (!(yield* appWindowSender(event))) return null;
    const input = decodeWithdrawMain(raw);
    if (Option.isNone(input)) return null;
    return yield* withdrawFromMain(input.value);
  },
);

const decodeChromeSignIn = Schema.decodeUnknownOption(ChromeSignInInput);
const decodeEndChromeSignIn = Schema.decodeUnknownOption(
  Schema.Struct({
    keep: Schema.Boolean,
    attemptId: Schema.String.check(Schema.isMaxLength(128)),
  }),
);
const chromeSignInHandler = Effect.fn("DesktopAccounts.chromeSignInHandler")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  const input = decodeChromeSignIn(raw);
  if (!(yield* appWindowSender(event)) || Option.isNone(input)) return { outcome: "failed" };
  const window = yield* appWindowForSender(yield* ElectronWindow, event?.sender.id);
  const platform = yield* HostProcess.Platform;
  return yield* chromeSignIn(
    input.value,
    Option.isSome(window) ? signInHost(window.value, platform) : undefined,
  );
});

/**
 * The browser opens centred over Scient's window; full screen, macOS switches to it instead, as no
 * other app's window can cover a full-screen one. Scient comes back when the sign-in ends.
 */
const signInHost = (window: Electron.BrowserWindow, platform: NodeJS.Platform): SignInHost => {
  const bounds = window.getBounds();
  return {
    position: window.isFullScreen()
      ? undefined
      : {
          x: bounds.x + (bounds.width - WINDOW_SIZE.width) / 2,
          y: bounds.y + (bounds.height - WINDOW_SIZE.height) / 2,
        },
    focus: () => {
      if (window.isDestroyed()) return;
      if (platform === "darwin") Electron.app.focus({ steal: true });
      window.focus();
    },
  };
};

const decodeForget = Schema.decodeUnknownOption(
  Schema.Struct({ profileId: BrowserProfileId, since: Schema.optional(Schema.String) }),
);
/** Forget the sign-in window of a profile: its folder, and the sign-ins the browser kept there. */
const forgetChromeSignIn = Effect.fn("DesktopAccounts.forgetChromeSignIn")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return false;
  const input = decodeForget(raw);
  if (Option.isNone(input)) return false;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const folder = signInFolder(environment.stateDir, input.value.profileId);
  // Not while its window is open, and not over a sign-in made there since `since`.
  return yield* Effect.promise(() => forgetSignInWindow(folder, input.value.since));
});

const sourceProfiles = Effect.fn("DesktopAccounts.discoverProfiles")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event)) || raw !== undefined) return [];
  return yield* discoverSourceProfiles();
});

const decodeSourceId = Schema.decodeUnknownOption(BrowserImportSourceId);
/** Whether a browser that hands its cookies over itself has remote debugging on; never asks. */
const browserConnection = Effect.fn("DesktopAccounts.browserConnection")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return null;
  const sourceId = decodeSourceId(raw);
  const definition = Option.isSome(sourceId)
    ? BROWSER_IMPORT_SOURCES.find(({ id }) => id === sourceId.value)
    : undefined;
  if (definition === undefined) return null;
  const on = yield* throughBrowserIsOn(definition, yield* sourcePathContext);
  return on === undefined ? null : { on };
});

/**
 * Sign-in codes' one-click way to Full Disk Access, on the Mac that reads them: Messages is asked
 * once so macOS lists Scient, the pane opens, and Finder shows the app to drag in if it isn't.
 */
const openFullDiskAccess = Effect.fn("DesktopAccounts.openFullDiskAccess")(function* (
  _raw: unknown,
  event?: AccountsInvokeEvent,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (!(yield* appWindowSender(event)) || environment.platform !== "darwin") return false;
  yield* Effect.sync(() => askForMessages());
  const opened = yield* Effect.promise(() =>
    Electron.shell.openExternal(FULL_DISK_ACCESS_URL).then(
      () => true,
      () => false,
    ),
  );
  const bundle = appBundleOf(process.execPath);
  if (bundle !== undefined) yield* Effect.sync(() => Electron.shell.showItemInFolder(bundle));
  return opened;
});

/** Restart Scient: for the rare grant a fresh reader still doesn't see. */
const relaunch = Effect.fn("DesktopAccounts.relaunch")(function* (
  _raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return false;
  yield* (yield* DesktopLifecycle.DesktopLifecycle).relaunch("full-disk-access");
  return true;
});

const decodePasswordSource = Schema.decodeUnknownOption(
  Schema.Struct({
    sourceId: BrowserImportSourceId,
    directory: Schema.String.check(Schema.isMaxLength(256)),
    profileId: Schema.optional(BrowserProfileId),
    refresh: Schema.optional(Schema.Literal(true)),
    operationId: Schema.optional(ProfileOperationId),
  }),
);
/**
 * A Chromium profile's saved passwords, read from a snapshot and handed by this process straight
 * to its own backend's Accounts (round 6f): the page never holds them, nor picks where they go.
 */
export const importBrowserPasswordsHere = Effect.fn("DesktopAccounts.importBrowserPasswords")(
  function* (raw: unknown, event?: AccountsInvokeEvent) {
    if (!(yield* appWindowSender(event))) return null;
    const decoded = decodePasswordSource(raw);
    if (Option.isNone(decoded)) return null;
    const { sourceId, directory, profileId, refresh, operationId } = decoded.value;
    const csv = yield* readBrowserPasswords(sourceId, directory).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (!csv) return null;
    const reply = yield* importPasswordsHere({
      format: "chrome",
      content: csv.content,
      origin: "browser",
      ...(profileId ? { profileId } : {}),
      ...(refresh ? { refresh } : {}),
      ...(operationId ? { operationId } : {}),
    });
    return reply ? { ...reply, skipped: csv.skipped } : null;
  },
);

const decodeSite = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253)),
);

export const installAccountsIpc = Effect.fn("DesktopAccounts.installIpc")(function* () {
  const ipc = yield* DesktopIpc;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  // Each profile's partition as its last Clear left it; sign-out saves past their hour go.
  loadProfileGenerations(environment.stateDir);
  const startedAt = yield* Clock.currentTimeMillis;
  yield* Effect.sync(() => sweepSignOutSaves(environment.stateDir, startedAt)).pipe(Effect.ignore);
  const siteIcons = yield* makeSiteIcons(
    environment.path.join(environment.stateDir, "scient", "site-icons.json"),
  );
  yield* ipc.handle({
    channel: Channels.SITE_ICON,
    handler: Effect.fn("DesktopAccounts.siteIcon")(function* (
      raw: unknown,
      event?: AccountsInvokeEvent,
    ) {
      const site = decodeSite(raw);
      if (!(yield* appWindowSender(event)) || Option.isNone(site)) return null;
      return yield* siteIcons(site.value);
    }),
  });
  yield* ipc.handle({
    channel: Channels.IMPORT_BROWSER_PASSWORDS,
    handler: importBrowserPasswordsHere,
  });
  yield* ipc.handle({ channel: Channels.SOURCE_PROFILES, handler: sourceProfiles });
  yield* ipc.handle({ channel: Channels.BROWSER_CONNECTION, handler: browserConnection });
  yield* ipc.handle({ channel: Channels.OPEN_FULL_DISK_ACCESS, handler: openFullDiskAccess });
  yield* ipc.handle({ channel: Channels.RELAUNCH, handler: relaunch });
  yield* ipc.handle({ channel: Channels.SIGNED_IN_SITES, handler: signedInSites });
  yield* ipc.handle({ channel: Channels.COOKIE_METADATA, handler: cookieMetadata });
  yield* ipc.handle({ channel: Channels.GOOGLE_SESSIONS, handler: googleSessions });
  yield* ipc.handle({ channel: Channels.QUIET_VISIT, handler: visitQuietly });
  yield* ipc.handle({ channel: Channels.SIGN_OUT_SITE, handler: signOutSite });
  yield* ipc.handle({ channel: Channels.PROFILE_GENERATIONS, handler: profileGenerations });
  yield* ipc.handle({ channel: Channels.SAVE_DEADLINES, handler: undoDeadlines });
  yield* ipc.handle({ channel: Channels.SIGN_OUT_KEPT, handler: signOutKept });
  yield* ipc.handle({ channel: Channels.RESTORE_SIGN_OUT, handler: restoreSignOut });
  yield* ipc.handle({ channel: Channels.PURGE_PROFILE_DATA, handler: purgeProfileData });
  yield* ipc.handle({ channel: Channels.COPY_PROFILE_SITES, handler: copyProfileSites });
  yield* ipc.handle({ channel: Channels.UNDO_PROFILE_COPY, handler: undoProfileCopyHandler });
  yield* ipc.handle({ channel: Channels.FILL_MAIN, handler: fillMainHandler });
  yield* ipc.handle({ channel: Channels.READ_SESSIONS, handler: readSessionsHandler });
  yield* ipc.handle({ channel: Channels.SIGN_OUT_MAIN_SITE, handler: signOutMainHandler });
  yield* ipc.handle({ channel: Channels.WITHDRAW_FROM_MAIN, handler: withdrawFromMainHandler });
  yield* ipc.handle({
    channel: Channels.ACCOUNTS_OWNER,
    handler: Effect.fn("DesktopAccounts.accountsOwner")(function* (
      _raw: unknown,
      event?: AccountsInvokeEvent,
    ) {
      if (!(yield* appWindowSender(event))) return false;
      return accountsOwner(yield* (yield* ElectronWindow).appWindows) === event?.sender.id;
    }),
  });
  yield* ipc.handle({
    channel: Channels.CHROME_SIGN_IN_BROWSER,
    handler: Effect.fn("DesktopAccounts.chromeSignInBrowser")(function* (
      _raw: unknown,
      event?: AccountsInvokeEvent,
    ) {
      if (!(yield* appWindowSender(event))) return null;
      return yield* chromeSignInBrowser;
    }),
  });
  yield* ipc.handle({ channel: Channels.CHROME_SIGN_IN, handler: chromeSignInHandler });
  yield* ipc.handle({ channel: Channels.FORGET_CHROME_SIGN_IN, handler: forgetChromeSignIn });
  yield* ipc.handle({
    channel: Channels.END_CHROME_SIGN_IN,
    handler: Effect.fn("DesktopAccounts.endChromeSignInHandler")(function* (
      raw: unknown,
      event?: AccountsInvokeEvent,
    ) {
      if (!(yield* appWindowSender(event))) return false;
      if (typeof raw === "boolean") return yield* endChromeSignIn(raw);
      const ending = decodeEndChromeSignIn(raw);
      if (Option.isNone(ending)) return false;
      return yield* endChromeSignIn(ending.value.keep, ending.value.attemptId);
    }),
  });
  yield* ipc.handle({ channel: Channels.FILL, handler: fill });
  yield* ipc.handle({ channel: Channels.LOGIN_FORM, handler: inspectLoginForm });
  yield* ipc.handle({ channel: Channels.SIGN_IN_PAGE, handler: inspectSignInPage });
  yield* ipc.handle({ channel: Channels.PAGE_SECRETS, handler: readPageSecrets });
  yield* ipc.handle({ channel: Channels.SEEK_PASSWORD_PAGE, handler: seekPasswordPage });
  if (!Electron.app.isPackaged)
    yield* ipc.handle({
      channel: Channels.QUALIFY_SESSION_COPY,
      handler: Effect.fn("DesktopAccounts.qualifySessionCopyHandler")(function* (
        _raw: unknown,
        event?: AccountsInvokeEvent,
      ) {
        if (!(yield* appWindowSender(event))) return null;
        // Loaded only here: a packaged build never registers this channel.
        const { qualifySessionCopy } = yield* Effect.promise(
          () => import("./qualifySessionCopy.ts"),
        );
        return yield* Effect.promise(qualifySessionCopy);
      }),
    });
  const manager = yield* PreviewManager;
  const context = yield* Effect.context<PreviewManager | ElectronWindow>();
  const runPromise = Effect.runPromiseWith(context);
  const runSync = Effect.runSyncWith(context);
  const allowed = (event: Electron.IpcMainEvent) => {
    event.returnValue =
      isCaptureGuest(event) &&
      runSync(manager.accountsTabIdForWebContents(event.sender.id)) !== null;
  };
  const capture = (event: Electron.IpcMainEvent, raw: unknown) => {
    void runPromise(forwardCapturedSignIn(event, raw).pipe(Effect.ignore)).catch(() => undefined);
  };
  const detected = (event: Electron.IpcMainEvent) => {
    void runPromise(forwardLoginForm(event).pipe(Effect.ignore)).catch(() => undefined);
  };
  // A window closing may move the background work: every window asks again.
  const ownerMayChange = (_event: unknown, window: Electron.BrowserWindow) =>
    window.once("closed", () => {
      void runPromise(
        Effect.gen(function* () {
          for (const open of yield* (yield* ElectronWindow).appWindows)
            if (!open.webContents.isDestroyed())
              open.webContents.send(Channels.ACCOUNTS_OWNER_CHANGED);
        }),
      ).catch(() => undefined);
    });
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      onGoogleActivity(() => {
        void runPromise(
          Effect.gen(function* () {
            for (const open of yield* (yield* ElectronWindow).appWindows)
              if (!open.webContents.isDestroyed()) open.webContents.send(Channels.GOOGLE_ACTIVITY);
          }),
        ).catch(() => undefined);
      }),
    ),
    (off) => Effect.sync(off),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      for (const window of Electron.BrowserWindow.getAllWindows()) ownerMayChange(null, window);
      Electron.app.on("browser-window-created", ownerMayChange);
    }),
    () => Effect.sync(() => Electron.app.removeListener("browser-window-created", ownerMayChange)),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      Electron.ipcMain.on(Channels.CAPTURE_ALLOWED, allowed);
      Electron.ipcMain.on(Channels.CAPTURE, capture);
      Electron.ipcMain.on(Channels.LOGIN_FORM_REPORT, detected);
    }),
    () =>
      Effect.sync(() => {
        Electron.ipcMain.removeListener(Channels.CAPTURE_ALLOWED, allowed);
        Electron.ipcMain.removeListener(Channels.CAPTURE, capture);
        Electron.ipcMain.removeListener(Channels.LOGIN_FORM_REPORT, detected);
      }),
  );
});

const isCaptureGuest = (event: Electron.IpcMainEvent) => {
  const contents = event.sender;
  const identity = accountsSessionIdentity(contents.session);
  return (
    !contents.isDestroyed() &&
    contents.getType() === "webview" &&
    event.senderFrame === contents.mainFrame &&
    identity?.persistent === true
  );
};

/** A guest tab as the submit watch reads it: its loads, its main-frame moves, its page. */
const submitTab = (contents: Electron.WebContents): SubmitTab => ({
  id: contents.id,
  isLoading: () => contents.isDestroyed() || contents.isLoading(),
  look: async () =>
    contents.isDestroyed()
      ? null
      : ((await contents.executeJavaScriptInIsolatedWorld(PRELOAD_WORLD_ID, [
          { code: submitPageLookScript },
        ])) as SubmitLook | null),
  onNavigated: (listener) => {
    const navigated = (_event: unknown, url: string) => listener(url);
    contents.on("did-navigate", navigated);
    return () => contents.off("did-navigate", navigated);
  },
  onDestroyed: (listener) => {
    contents.once("destroyed", listener);
    return () => contents.off("destroyed", listener);
  },
});

export const forwardCapturedSignIn = Effect.fn("DesktopAccounts.forwardCapturedSignIn")(function* (
  event: Electron.IpcMainEvent,
  raw: unknown,
) {
  if (!isCaptureGuest(event)) return;
  const decoded = decodeCapture(raw);
  if (Option.isNone(decoded)) return;
  const identity = accountsSessionIdentity(event.sender.session);
  if (!identity) return;
  const manager = yield* PreviewManager;
  const windows = yield* ElectronWindow;
  const tabId = yield* manager.accountsTabIdForWebContents(event.sender.id);
  const hostWindow = yield* appWindowForSender(windows, event.sender.hostWebContents?.id);
  if (tabId === null || Option.isNone(hostWindow)) return;
  const contents = yield* manager.accountsWebContents(tabId);
  if (contents !== event.sender || !isCaptureGuest(event)) return;
  const origin = safeHttpOrigin(contents.getURL());
  if (origin === null || decoded.value.url !== origin) return;
  const { step, username, password, path, newPassword } = decoded.value;
  // A change or sign-in form was sent: its own request is looked for (see `armFill`), briefly.
  if (newPassword || password) submitSeen(contents.id);
  const key = `${tabId}\u0000${origin}`;
  const now = yield* Clock.currentTimeMillis;
  // A username step is kept for the password step that follows, in this process: a page's own
  // memory ends with the page. It is never sent on its own.
  if (step === "username" && !newPassword) {
    if (username) earlierUsernames.set(key, { username, at: now });
    return;
  }
  if (!password && !newPassword) return;
  const earlier = earlierUsernames.get(key);
  earlierUsernames.delete(key);
  const carried = !username && earlier && now - earlier.at < USERNAME_STEP_MS;
  hostWindow.value.webContents.send(Channels.CAPTURED, {
    url: origin,
    path,
    step: "password",
    username: carried ? earlier.username : username,
    password,
    ...(newPassword ? { newPassword } : {}),
    usernameFrom: carried ? "earlier-step" : "form",
    tabId,
    profileId: identity.profileId,
  } satisfies DesktopCapturedSignIn);
});

const USERNAME_STEP_MS = 10 * 60_000;
const earlierUsernames = new Map<string, { readonly username: string; readonly at: number }>();

const FormReport = Schema.Struct({
  url: Schema.String,
  documentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  userEdited: Schema.Boolean,
  hasPassword: Schema.Boolean,
  hasValues: Schema.Boolean,
  boxes: Schema.Array(
    Schema.Struct({
      email: Schema.Boolean,
      minLength: Schema.Number,
      maxLength: Schema.Number,
      pattern: Schema.String.check(Schema.isMaxLength(1024)),
    }),
  ).check(Schema.isMaxLength(2)),
  offer: Schema.optional(AccountPageOffer),
  newPassword: Schema.optional(
    Schema.Struct({
      minLength: Schema.Number,
      maxLength: Schema.Number,
      pattern: Schema.String.check(Schema.isMaxLength(1024)),
      passwordRules: Schema.String.check(Schema.isMaxLength(1024)),
      statedMinLength: Schema.Number,
      statedMaxLength: Schema.Number,
      required: Schema.Array(Schema.Literals(["lower", "upper", "digit", "symbol"])).check(
        Schema.isMaxLength(4),
      ),
      noSymbols: Schema.Boolean,
      refusal: Schema.Boolean,
    }),
  ),
});
const decodeFormReport = Schema.decodeUnknownOption(FormReport);
const TabInput = Schema.Struct({ tabId: DesktopPreviewTabInputSchema.fields.tabId });
const decodeTabInput = Schema.decodeUnknownOption(TabInput);
const readLoginForm = Effect.fn("DesktopAccounts.readLoginForm")(function* (tabId: string) {
  const manager = yield* PreviewManager;
  const contents = yield* manager.accountsWebContents(tabId);
  const identity = accountsSessionIdentity(contents.session);
  if (contents.isDestroyed() || contents.getType() !== "webview" || identity?.persistent !== true)
    return null;
  const result = yield* Effect.tryPromise({
    try: () =>
      contents.executeJavaScriptInIsolatedWorld(PRELOAD_WORLD_ID, [
        { code: loginFormReportScript },
      ]),
    catch: unavailable,
  });
  const report = decodeFormReport(result);
  if (Option.isNone(report) || report.value.url !== safeHttpOrigin(contents.getURL())) return null;
  return { ...report.value, pageUrl: contents.getURL(), tabId, profileId: identity.profileId };
});
const inspectLoginForm = Effect.fn("DesktopAccounts.inspectLoginForm")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return null;
  const input = decodeTabInput(raw);
  if (Option.isNone(input)) return null;
  return yield* readLoginForm(input.value.tabId).pipe(Effect.orElseSucceed(() => null));
});
const decodeSignInPageState = Schema.decodeUnknownOption(
  Schema.Literals(["loading", "login", "code", "done"]),
);
/** Where the sign-in on a Scient tab stands now, and the page it is on. */
const inspectSignInPage = Effect.fn("DesktopAccounts.inspectSignInPage")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return null;
  const input = decodeTabInput(raw);
  if (Option.isNone(input)) return null;
  return yield* Effect.gen(function* () {
    const manager = yield* PreviewManager;
    const contents = yield* manager.accountsWebContents(input.value.tabId);
    if (contents.isDestroyed() || contents.getType() !== "webview") return null;
    // The answer to its last change form's own request, as read right after it came.
    const submitted = submitAnswer(contents.id);
    // Still loading by Electron's account too: the page may yet show a code box.
    if (contents.isLoading())
      return {
        state: "loading" as const,
        url: contents.getURL(),
        ...(submitted ? { submitted } : {}),
      };
    const result = yield* Effect.tryPromise({
      try: () =>
        contents.executeJavaScriptInIsolatedWorld(PRELOAD_WORLD_ID, [
          { code: signInPageStateScript },
        ]),
      catch: unavailable,
    });
    const state = decodeSignInPageState(result);
    if (Option.isNone(state)) return null;
    const failed = yield* Effect.tryPromise({
      try: () =>
        contents.executeJavaScriptInIsolatedWorld(PRELOAD_WORLD_ID, [
          { code: documentFailedScript },
        ]),
      catch: unavailable,
    });
    // A lockout or rate-limit page: a form shown again there says nothing of the password.
    const limited = yield* Effect.tryPromise({
      try: () =>
        contents.executeJavaScriptInIsolatedWorld(PRELOAD_WORLD_ID, [{ code: pageLimitedScript }]),
      catch: unavailable,
    });
    // Which document: an answer counts only on a page that replaced the form's own.
    const documentId = yield* Effect.tryPromise({
      try: () =>
        contents.executeJavaScriptInIsolatedWorld(PRELOAD_WORLD_ID, [{ code: documentIdScript }]),
      catch: unavailable,
    });
    return {
      state: state.value,
      url: contents.getURL(),
      ...(failed === true ? { failed: true as const } : {}),
      ...(limited === true ? { limited: true as const } : {}),
      ...(typeof documentId === "string" ? { documentId: documentId.slice(0, 64) } : {}),
      ...(submitted ? { submitted } : {}),
    };
  }).pipe(Effect.orElseSucceed(() => null));
});
const PageSecretsInput = Schema.Struct({
  tabId: DesktopPreviewTabInputSchema.fields.tabId,
  offer: AccountPageOffer,
  documentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
const PageSecrets = Schema.Union([
  Schema.Struct({ origin: Schema.String.check(Schema.isMaxLength(2048)), setup: AccountSetupPage }),
  Schema.Struct({
    origin: Schema.String.check(Schema.isMaxLength(2048)),
    codes: Schema.Array(Schema.String.check(Schema.isMaxLength(32))).check(Schema.isMaxLength(20)),
  }),
]);
const decodePageSecretsInput = Schema.decodeUnknownOption(PageSecretsInput);
const decodePageSecrets = Schema.decodeUnknownOption(PageSecrets);
const encodeSealedPage = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
/**
 * What a 2FA setup or backup-code page in the person's own tab shows (never an incognito one),
 * read in the isolated world, in the document its form report named only; sealed here for the
 * local backend, once, with the page's origin, the tab's profile and the document bound to it.
 */
const readPageSecrets = Effect.fn("DesktopAccounts.readPageSecrets")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return null;
  const input = decodePageSecretsInput(raw);
  if (Option.isNone(input)) return null;
  return yield* Effect.gen(function* () {
    const manager = yield* PreviewManager;
    const contents = yield* manager.accountsWebContents(input.value.tabId);
    const identity = accountsSessionIdentity(contents.session);
    if (
      contents.isDestroyed() ||
      contents.getType() !== "webview" ||
      identity?.persistent !== true ||
      !safeHttpOrigin(contents.getURL())?.startsWith("https://")
    )
      return null;
    const result = yield* Effect.tryPromise({
      try: () =>
        contents.executeJavaScriptInIsolatedWorld(PRELOAD_WORLD_ID, [
          { code: pageSecretsScript(input.value.offer, input.value.documentId) },
        ]),
      catch: unavailable,
    });
    const read = decodePageSecrets(result);
    // The origin the page had as it was read, which must still be the tab's: a page that moved
    // meanwhile seals nothing.
    if (Option.isNone(read)) return null;
    const { origin, ...secrets } = read.value;
    if (!origin.startsWith("https://") || safeHttpOrigin(contents.getURL()) !== origin) return null;
    // Only for the primary backend this desktop runs: the only one given the page-seal secret.
    const backend = yield* (yield* DesktopBackendPool.DesktopBackendPool).primary;
    const config = yield* backend.currentConfig;
    const secret = Option.isSome(config) ? config.value.bootstrap.desktopPageSealSecret : undefined;
    if (secret === undefined) return null;
    const text = yield* encodeSealedPage(secrets);
    const sealed = sealPageSecrets(
      pageSealKey(secret),
      {
        at: yield* Clock.currentTimeMillis,
        origin,
        profileId: identity.profileId,
        documentId: input.value.documentId,
        offer: input.value.offer,
      },
      text,
    );
    return sealed === undefined ? null : { sealed };
  }).pipe(Effect.orElseSucceed(() => null));
});
const SeekInput = Schema.Struct({
  tabId: DesktopPreviewTabInputSchema.fields.tabId,
  origin: Schema.String.check(Schema.isMaxLength(2048)),
});
const decodeSeekInput = Schema.decodeUnknownOption(SeekInput);
/** A Fix's walk to the site's change-password page, in the tab and on the origin it opened. */
const seekPasswordPage = Effect.fn("DesktopAccounts.seekPasswordPage")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* appWindowSender(event))) return false;
  const input = decodeSeekInput(raw);
  if (Option.isNone(input)) return false;
  const origin = URL.parse(input.value.origin)?.origin;
  if (!origin?.startsWith("https://")) return false;
  return yield* Effect.gen(function* () {
    const manager = yield* PreviewManager;
    const contents = yield* manager.accountsWebContents(input.value.tabId);
    if (contents.isDestroyed() || contents.getType() !== "webview") return false;
    // A main-frame navigation's start, as a walk listener: stopping it stops the tab.
    const started = new Map<
      Parameters<WalkTab["on"]>[1],
      (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => void
    >();
    const tab: WalkTab = {
      getURL: () => contents.getURL(),
      read: () =>
        contents.executeJavaScriptInIsolatedWorld(PRELOAD_WORLD_ID, [{ code: passwordPageScript }]),
      loadURL: (url) => contents.loadURL(url),
      on: (name, listener) => {
        if (name !== "did-start-navigation") {
          contents.on(name as "will-redirect", listener);
          return;
        }
        const onStart = (
          details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
        ) => {
          if (details.isMainFrame) listener({ preventDefault: () => contents.stop() }, details.url);
        };
        started.set(listener, onStart);
        contents.on("did-start-navigation", onStart);
      },
      off: (name, listener) => {
        if (name !== "did-start-navigation") {
          contents.off(name as "will-redirect", listener);
          return;
        }
        const onStart = started.get(listener);
        if (onStart) contents.off("did-start-navigation", onStart);
        started.delete(listener);
      },
    };
    return yield* Effect.tryPromise({
      try: () => walkToPasswordPage(tab, origin),
      catch: unavailable,
    });
  }).pipe(Effect.orElseSucceed(() => false));
});
const forwardLoginForm = Effect.fn("DesktopAccounts.forwardLoginForm")(function* (
  event: Electron.IpcMainEvent,
) {
  if (!isCaptureGuest(event)) return;
  const manager = yield* PreviewManager;
  const windows = yield* ElectronWindow;
  const tabId = yield* manager.accountsTabIdForWebContents(event.sender.id);
  const hostWindow = yield* appWindowForSender(windows, event.sender.hostWebContents?.id);
  if (tabId === null || Option.isNone(hostWindow)) return;
  if ((yield* manager.accountsWebContents(tabId)) !== event.sender) return;
  const form = yield* readLoginForm(tabId);
  if (form && isCaptureGuest(event))
    hostWindow.value.webContents.send(Channels.LOGIN_FORM_DETECTED, form);
});
