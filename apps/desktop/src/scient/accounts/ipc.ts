import {
  BrowserProfileId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  EnvironmentId,
  DesktopPreviewTabInputSchema,
} from "@t3tools/contracts";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DesktopIpc, type DesktopIpcInvokeEvent } from "../../ipc/DesktopIpc.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { PreviewManager } from "../../preview/Manager.ts";
import { safeHttpOrigin } from "../../preview/FaviconCapture.ts";
import { resolvePartitionScope } from "../../ipc/methods/preview.ts";
import { discoverSourceProfiles } from "./sourceProfiles.ts";
import { groupSignedInSites } from "./signedInSites.ts";
import { loginFillScript, loginFormReportScript } from "./loginFields.ts";
import { accountsSessionIdentity } from "./sessionIdentity.ts";
import { DesktopAccountsError } from "./errors.ts";
import * as Channels from "./protocol.ts";

const Value = Schema.String.check(Schema.isMaxLength(65_536));
const Fill = Schema.Struct({
  tabId: DesktopPreviewTabInputSchema.fields.tabId,
  expectedOrigin: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  username: Schema.optional(Value),
  password: Schema.optional(Value),
  otp: Schema.optional(Value),
  documentId: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  automatic: Schema.optional(Schema.Boolean),
});
const Sites = Schema.Struct({
  profileId: BrowserProfileId,
  environmentId: Schema.optional(EnvironmentId),
});
const Capture = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2048)),
  username: Value,
  password: Value.check(Schema.isMinLength(1)),
});

const decodeFill = Schema.decodeUnknownOption(Fill);
const decodeSites = Schema.decodeUnknownOption(Sites);
const decodeCapture = Schema.decodeUnknownOption(Capture);

type AccountsInvokeEvent = DesktopIpcInvokeEvent & { readonly senderFrame?: unknown };

const mainSender = Effect.fn("DesktopAccounts.mainSender")(function* (event?: AccountsInvokeEvent) {
  const windows = yield* ElectronWindow;
  const main = yield* windows.main;
  return (
    Option.isSome(main) &&
    !main.value.isDestroyed() &&
    main.value.webContents.id === event?.sender.id &&
    "senderFrame" in event &&
    event.senderFrame === main.value.webContents.mainFrame
  );
});

const unavailable = () => new DesktopAccountsError({});

export const fill = Effect.fn("DesktopAccounts.fill")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* mainSender(event))) return false;
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
    return yield* Effect.tryPromise({
      try: () =>
        contents
          .executeJavaScriptInIsolatedWorld(999, [
            { code: loginFillScript(input.value, origin, input.value) },
          ])
          .then((result: unknown) => result === true),
      catch: unavailable,
    });
  }).pipe(Effect.orElseSucceed(() => false));
});

export const signedInSites = Effect.fn("DesktopAccounts.signedInSites")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* mainSender(event))) return [];
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

const sourceProfiles = Effect.fn("DesktopAccounts.discoverProfiles")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* mainSender(event)) || raw !== undefined) return [];
  return yield* discoverSourceProfiles();
});

export const installAccountsIpc = Effect.fn("DesktopAccounts.installIpc")(function* () {
  const ipc = yield* DesktopIpc;
  yield* ipc.handle({ channel: Channels.SOURCE_PROFILES, handler: sourceProfiles });
  yield* ipc.handle({ channel: Channels.SIGNED_IN_SITES, handler: signedInSites });
  yield* ipc.handle({ channel: Channels.FILL, handler: fill });
  yield* ipc.handle({ channel: Channels.LOGIN_FORM, handler: inspectLoginForm });
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
  const main = yield* windows.main;
  if (
    tabId === null ||
    Option.isNone(main) ||
    event.sender.hostWebContents !== main.value.webContents
  )
    return;
  const contents = yield* manager.accountsWebContents(tabId);
  if (contents !== event.sender || !isCaptureGuest(event)) return;
  const origin = safeHttpOrigin(contents.getURL());
  if (origin === null || decoded.value.url !== origin) return;
  main.value.webContents.send(Channels.CAPTURED, {
    ...decoded.value,
    url: origin,
    tabId,
    profileId: identity.profileId,
  });
});

const FormReport = Schema.Struct({
  url: Schema.String,
  documentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  userEdited: Schema.Boolean,
  hasValues: Schema.Boolean,
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
    try: () => contents.executeJavaScriptInIsolatedWorld(999, [{ code: loginFormReportScript }]),
    catch: unavailable,
  });
  const report = decodeFormReport(result);
  if (Option.isNone(report) || report.value.url !== safeHttpOrigin(contents.getURL())) return null;
  return { ...report.value, tabId, profileId: identity.profileId };
});
const inspectLoginForm = Effect.fn("DesktopAccounts.inspectLoginForm")(function* (
  raw: unknown,
  event?: AccountsInvokeEvent,
) {
  if (!(yield* mainSender(event))) return null;
  const input = decodeTabInput(raw);
  if (Option.isNone(input)) return null;
  return yield* readLoginForm(input.value.tabId).pipe(Effect.orElseSucceed(() => null));
});
const forwardLoginForm = Effect.fn("DesktopAccounts.forwardLoginForm")(function* (
  event: Electron.IpcMainEvent,
) {
  if (!isCaptureGuest(event)) return;
  const manager = yield* PreviewManager;
  const windows = yield* ElectronWindow;
  const tabId = yield* manager.accountsTabIdForWebContents(event.sender.id);
  const main = yield* windows.main;
  if (
    tabId === null ||
    Option.isNone(main) ||
    event.sender.hostWebContents !== main.value.webContents
  )
    return;
  if ((yield* manager.accountsWebContents(tabId)) !== event.sender) return;
  const form = yield* readLoginForm(tabId);
  if (form && isCaptureGuest(event))
    main.value.webContents.send(Channels.LOGIN_FORM_DETECTED, form);
});
