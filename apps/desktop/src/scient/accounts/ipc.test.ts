// @effect-diagnostics nodeBuiltinImport:off -- Generate ephemeral synthetic values instead of credential fixtures.
import * as NodeCrypto from "node:crypto";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { PreviewManager } from "../../preview/Manager.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { rememberAccountsSession } from "./sessionIdentity.ts";
import { cookieMetadata, fill, forwardCapturedSignIn, signedInSites } from "./ipc.ts";

vi.mock("electron", () => ({
  BrowserWindow: {},
  app: {},
  webContents: {},
  session: {},
  nativeImage: {},
  shell: {},
  clipboard: {},
  ClipboardItem: {},
}));

function fixture() {
  const sent: unknown[] = [];
  const frame = {};
  const mainContents = {
    id: 1,
    mainFrame: frame,
    isDestroyed: () => false,
    send: (_channel: string, payload: unknown) => sent.push(payload),
  };
  const session = {} as Electron.Session;
  rememberAccountsSession(session, JSON.stringify(["remote", "work"]), true, "profile");
  let url = "https://example.test/login";
  const guest = {
    id: 2,
    session,
    mainFrame: {},
    hostWebContents: mainContents,
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => url,
    executeJavaScript: async () => true,
  } as unknown as Electron.WebContents;
  let failCookies = false;
  let registered = true;
  const scopes: unknown[] = [];
  const layer = Layer.mergeAll(
    Layer.mock(PreviewManager)({
      isBrowserPartition: () => true,
      accountsTabIdForWebContents: (id) =>
        Effect.succeed(registered && id === guest.id ? "tab" : null),
      accountsWebContents: () => Effect.succeed(guest),
      getBrowserSession: (scope, persistent, namespace) => {
        scopes.push({ scope, persistent, namespace });
        return Effect.succeed({
          cookies: {
            get: async () => {
              if (failCookies) throw new Error("Synthetic cookie failure");
              return [
                {
                  domain: ".example.test",
                  expirationDate: 2000,
                  httpOnly: true,
                  value: NodeCrypto.randomBytes(16).toString("hex"),
                },
              ];
            },
          },
        } as unknown as Electron.Session);
      },
    }),
    Layer.mock(ElectronWindow)({
      appWindows: Effect.succeed([
        {
          isDestroyed: () => false,
          webContents: mainContents,
        } as unknown as Electron.BrowserWindow,
      ]),
    }),
  );
  return {
    failCookieRead: () => {
      failCookies = true;
    },
    guest,
    sent,
    scopes,
    mainEvent: { sender: { id: 1 }, senderFrame: frame },
    guestEvent: { sender: guest, senderFrame: guest.mainFrame } as Electron.IpcMainEvent,
    unregister: () => {
      registered = false;
    },
    navigate: () => {
      url = "https://other.test/login";
    },
    run: <A, E>(effect: Effect.Effect<A, E, PreviewManager | ElectronWindow>) =>
      effect.pipe(Effect.provide(layer)),
  };
}

it.effect(
  "forwards a persistent registered guest with authoritative tab/profile and refuses unregistered, incognito and spoofed origins",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const capture = {
        url: "https://example.test",
        username: NodeCrypto.randomBytes(16).toString("hex"),
        password: NodeCrypto.randomBytes(16).toString("hex"),
      };
      yield* f.run(forwardCapturedSignIn(f.guestEvent, capture));
      expect(f.sent).toHaveLength(1);
      const payload = f.sent[0] as { tabId: string; profileId: string; password: string };
      expect([payload.tabId, payload.profileId]).toEqual(["tab", "work"]);
      expect(payload.password === capture.password).toBe(true);
      yield* f.run(forwardCapturedSignIn({ ...f.guestEvent, senderFrame: null }, capture));
      yield* f.run(forwardCapturedSignIn(f.guestEvent, { ...capture, password: {} }));
      f.navigate();
      yield* f.run(forwardCapturedSignIn(f.guestEvent, capture));
      rememberAccountsSession(
        f.guest.session,
        JSON.stringify(["remote", "incognito"]),
        true,
        "profile",
      );
      yield* f.run(forwardCapturedSignIn(f.guestEvent, { ...capture, url: "https://other.test" }));
      rememberAccountsSession(f.guest.session, "remote");
      f.unregister();
      yield* f.run(forwardCapturedSignIn(f.guestEvent, { ...capture, url: "https://other.test" }));
      expect(f.sent).toHaveLength(1);
    }),
);

it.effect(
  "isolates site inventory by environment and profile using the upstream partition mapping",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      expect(yield* f.run(signedInSites({ profileId: "default" }, f.mainEvent))).toEqual([
        { domain: "example.test", cookies: 1 },
      ]);
      expect(
        yield* f.run(signedInSites({ profileId: "work", environmentId: "remote" }, f.mainEvent)),
      ).toHaveLength(1);
      expect(f.scopes).toEqual([
        { scope: PRIMARY_LOCAL_ENVIRONMENT_ID, persistent: true, namespace: undefined },
        { scope: JSON.stringify(["remote", "work"]), persistent: true, namespace: "profile" },
      ]);
      expect(yield* f.run(signedInSites({ profileId: "\u0000" }, f.mainEvent))).toEqual([]);
      expect(yield* f.run(signedInSites({ profileId: "default" }, f.guestEvent))).toEqual([]);
      expect(f.scopes).toHaveLength(2);
    }),
);

it.effect("accepts fill only from the application main frame and rejects invalid inputs", () =>
  Effect.gen(function* () {
    const f = fixture();
    const input = { tabId: "tab", password: NodeCrypto.randomBytes(16).toString("hex") };
    expect(yield* f.run(fill(input, f.mainEvent))).toBe(true);
    expect(
      yield* f.run(fill({ ...input, expectedOrigin: "https://other.test" }, f.mainEvent)),
    ).toBe(false);
    expect(yield* f.run(fill(input, f.guestEvent))).toBe(false);
    expect(yield* f.run(fill(input, { ...f.mainEvent, senderFrame: {} }))).toBe(false);
    expect(yield* f.run(fill({ ...input, tabId: 42 }, f.mainEvent))).toBe(false);
    expect(yield* f.run(fill({ ...input, password: {} }, f.mainEvent))).toBe(false);
    rememberAccountsSession(f.guest.session, "synthetic", false);
    expect(yield* f.run(fill({ ...input, automatic: true }, f.mainEvent))).toBe(false);
  }),
);

it.effect("returns only cookie metadata and distinguishes denied reads from empty profiles", () =>
  Effect.gen(function* () {
    const f = fixture();
    expect(
      yield* f.run(cookieMetadata({ profileId: "work", environmentId: "remote" }, f.mainEvent)),
    ).toEqual([{ domain: ".example.test", httpOnly: true, expires: 2000 }]);
    expect(yield* f.run(cookieMetadata({ profileId: "default" }, f.guestEvent))).toBeNull();
    expect(yield* f.run(cookieMetadata({ profileId: "\u0000" }, f.mainEvent))).toBeNull();
    f.failCookieRead();
    expect(yield* f.run(cookieMetadata({ profileId: "work" }, f.mainEvent))).toBeNull();
  }),
);
