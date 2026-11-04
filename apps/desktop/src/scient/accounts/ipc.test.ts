// @effect-diagnostics nodeBuiltinImport:off -- Generate ephemeral synthetic values instead of credential fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PRIMARY_LOCAL_ENVIRONMENT_ID, type SessionCookie } from "@t3tools/contracts";
import { BrowserImport } from "../../preview/BrowserImport/BrowserImport.ts";
import { PreviewManager } from "../../preview/Manager.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { rememberAccountsSession } from "./sessionIdentity.ts";
import {
  cookieMetadata,
  fill,
  fillMainHandler,
  forwardCapturedSignIn,
  signedInSites,
} from "./ipc.ts";
import { trackMainInserts } from "./mainInserts.ts";

vi.mock("./sessionCookies.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sessionCookies.ts")>()),
  withCookieDebugger: (
    session: { send: (method: string, params?: object) => Promise<unknown> },
    run: (send: (method: string, params?: object) => Promise<unknown>) => Promise<unknown>,
  ) => run(session.send),
}));

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

const fillInput = (input: Record<string, unknown>) => ({ mode: "fill", skipSites: [], ...input });
const allowed = { access: "allowed", scope: { type: "all-projects" } };

/** Jars kept in memory behind a fake debugger, with faults a test can set. */
function fillFixture() {
  const sessions = new Map<string, ReturnType<typeof fakeJarSession>>();
  const imports: Array<{ scope: string; persistent: boolean }> = [];
  const sessionFor = (scope: string, persistent = true, namespace?: "profile") => {
    let session = sessions.get(scope);
    if (!session) {
      session = fakeJarSession();
      sessions.set(scope, session);
      rememberAccountsSession(session as unknown as Electron.Session, scope, persistent, namespace);
      if (persistent) trackMainInserts(session as unknown as Electron.Session);
    }
    return session;
  };
  const frame = {};
  const mainContents = { id: 1, mainFrame: frame, isDestroyed: () => false };
  const layer = Layer.mergeAll(
    Layer.mock(PreviewManager)({
      isBrowserPartition: () => true,
      getBrowserSession: (scope = "shared", persistent, namespace) =>
        Effect.succeed(sessionFor(scope, persistent, namespace) as unknown as Electron.Session),
    }),
    Layer.mock(BrowserImport)({
      importCookies: ({ scope, persistent }) =>
        Effect.sync(() => {
          imports.push({ scope, persistent });
          sessionFor(scope, persistent).put(jarCookie({ domain: ".github.com", value: "import" }));
          return { imported: 1, skipped: 0, skippedDomains: [] };
        }),
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
  const event = { sender: { id: 1 }, senderFrame: frame };
  const profile = (id: string) =>
    sessionFor(JSON.stringify([PRIMARY_LOCAL_ENVIRONMENT_ID, id]), true, "profile");
  return {
    main: () => sessionFor(PRIMARY_LOCAL_ENVIRONMENT_ID),
    profile,
    imports,
    sessions,
    copy: (input: Record<string, unknown>, sender: unknown = event) =>
      fillMainHandler(fillInput(input), sender as never).pipe(Effect.provide(layer)),
  };
}

const jarCookie = (overrides: Partial<SessionCookie> = {}): SessionCookie => ({
  name: "session",
  value: "synthetic",
  domain: ".github.com",
  hostOnly: false,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  ...overrides,
});

function fakeJarSession() {
  const jar = new Map<string, SessionCookie>();
  const faults = {
    corruptNextSet: false,
    failDeletes: false,
    beforeSet: () => {},
    onSet: () => {},
  };
  const cookies = Object.assign(new NodeEvents.EventEmitter(), {
    flushStore: vi.fn(async () => undefined),
  });
  // One cookie per slot and partition, as in a real jar.
  const slot = (cookie: Pick<SessionCookie, "name" | "domain" | "path" | "partitionKey">) =>
    JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey ?? null]);
  const put = (cookie: SessionCookie, own = false) => {
    jar.set(slot(cookie), cookie);
    if (!own) cookies.emit("changed", {}, electronCookie(cookie), "inserted", false);
  };
  // Electron's change event, like its cookie API, names no partition.
  const electronCookie = ({ partitionKey: _, ...cookie }: SessionCookie) => ({
    ...cookie,
    session: cookie.expires === undefined,
  });
  const send = async (method: string, params?: { cookies?: Array<Record<string, never>> }) => {
    if (method === "Network.getAllCookies")
      return {
        cookies: [...jar.values()].map((cookie) => ({
          ...cookie,
          expires: cookie.expires ?? -1,
          session: cookie.expires === undefined,
          sameSite: { lax: "Lax", strict: "Strict", no_restriction: "None" }[
            cookie.sameSite as "lax"
          ],
        })),
      };
    if (method === "Network.setCookies") {
      faults.beforeSet();
      const corrupt = faults.corruptNextSet;
      faults.corruptNextSet = false;
      for (const param of params?.cookies ?? []) {
        const { url, sameSite, expires, domain, ...rest } = param as Record<string, unknown>;
        const cookie = {
          ...(rest as Omit<SessionCookie, "domain" | "hostOnly" | "sameSite">),
          domain: (domain as string | undefined) ?? new URL(url as string).hostname,
          hostOnly: domain === undefined,
          sameSite: ({ Lax: "lax", Strict: "strict", None: "no_restriction" } as const)[
            sameSite as "Lax"
          ],
          ...(expires === undefined ? {} : { expires: expires as number }),
        } as SessionCookie;
        jar.set(slot(cookie), corrupt ? { ...cookie, httpOnly: !cookie.httpOnly } : cookie);
        cookies.emit("changed", {}, electronCookie(cookie), "inserted", false);
      }
      faults.onSet();
      return {};
    }
    if (method === "Network.deleteCookies") {
      if (faults.failDeletes) throw new Error("Synthetic delete failure");
      jar.delete(slot(params as unknown as SessionCookie));
      return {};
    }
    throw new Error(`Unexpected ${method}`);
  };
  return {
    cookies,
    jar,
    faults,
    put,
    send,
    clearStorageData: vi.fn(async () => jar.clear()),
  };
}

describe("fillMain", () => {
  it.effect("refuses other senders, Main, Incognito and any restricted profile", () =>
    Effect.gen(function* () {
      const f = fillFixture();
      f.profile("work").put(jarCookie());
      expect(
        yield* f.copy({ from: "work", sourceControls: allowed }, { sender: { id: 2 } }),
      ).toBeNull();
      for (const refused of [
        { from: "default", sourceControls: allowed },
        { from: "incognito", sourceControls: allowed },
        { from: "work" },
        { from: "work", sourceControls: { ...allowed, access: "ask" } },
        {
          from: "work",
          sourceControls: { ...allowed, scope: { type: "projects", projectIds: [] } },
        },
        { from: "work", sourceControls: { ...allowed, allowedProjects: ["project-a"] } },
      ])
        expect(yield* f.copy(refused)).toBeNull();
      expect(f.main().jar.size).toBe(0);
    }),
  );

  it.effect(
    "copies a sign-in into an empty Main, leaves the source alone and returns no values",
    () =>
      Effect.gen(function* () {
        const f = fillFixture();
        const secret = NodeCrypto.randomBytes(16).toString("hex");
        f.profile("work").put(jarCookie({ value: secret }));
        const before = [...f.profile("work").jar.values()];
        const result = yield* f.copy({ from: "work", sourceControls: allowed });
        expect(result).toEqual({
          units: [{ sites: ["github.com"], outcome: "copied" }],
          unsupported: 0,
        });
        expect(JSON.stringify(result)).not.toContain(secret);
        expect([...f.main().jar.values()]).toEqual(before);
        expect([...f.profile("work").jar.values()]).toEqual(before);
      }),
  );

  it.effect("gives one copy and one conflict for two identities at once", () =>
    Effect.gen(function* () {
      const f = fillFixture();
      f.profile("work").put(jarCookie({ value: "work" }));
      f.profile("home").put(jarCookie({ value: "home" }));
      const results = yield* Effect.forEach(
        ["work", "home"],
        (from) =>
          f.copy({
            from,
            sourceControls: allowed,
            units: [["github.com"]],
            mode: "fill-or-replace",
          }),
        { concurrency: "unbounded" },
      );
      expect(results.map((result) => result?.units[0]?.outcome).toSorted()).toEqual([
        "conflict",
        "copied",
      ]);
    }),
  );

  it.effect(
    "replaces only when nothing touched Main since its sign-out, as far as the tracker knows",
    () =>
      Effect.gen(function* () {
        using _clock = fakeClock(1_000_000);
        const f = fillFixture();
        f.main().put(jarCookie({ value: "old" }), true);
        f.profile("work").put(jarCookie({ value: "new" }));
        const replace = (at: number) =>
          f.copy({
            from: "work",
            sourceControls: allowed,
            units: [["github.com"]],
            mode: "fill-or-replace",
            replaceAllowedSince: { "github.com": DateTime.formatIso(DateTime.makeUnsafe(at)) },
          });
        // Before the tracker started, it can't say.
        expect((yield* replace(999_000))?.units[0]?.outcome).toBe("conflict");
        vi.setSystemTime(1_010_000);
        f.main().put(jarCookie({ name: "page", value: "site" }));
        expect((yield* replace(1_005_000))?.units[0]?.outcome).toBe("conflict");
        f.main().jar.delete(JSON.stringify(["page", ".github.com", "/", null]));
        expect((yield* replace(1_020_000))?.units[0]?.outcome).toBe("copied");
        expect(f.main().jar.get(JSON.stringify(["session", ".github.com", "/", null]))?.value).toBe(
          "new",
        );
      }),
  );

  it.effect("keeps a site's own insert through a failed copy's restore", () =>
    Effect.gen(function* () {
      const f = fillFixture();
      f.profile("work").put(jarCookie());
      const main = f.main();
      main.faults.corruptNextSet = true;
      main.faults.onSet = () => {
        main.faults.onSet = () => {};
        main.put(jarCookie({ name: "page", value: "site" }));
      };
      const result = yield* f.copy({ from: "work", sourceControls: allowed });
      expect(result?.units[0]?.outcome).toBe("failed");
      expect([...main.jar.values()].map((cookie) => cookie.name)).toEqual(["page"]);
    }),
  );

  it.effect("leaves a cookie a navigation wrote just before the copy wrote the same name", () =>
    Effect.gen(function* () {
      const f = fillFixture();
      f.profile("work").put(jarCookie({ value: "from-work" }));
      const main = f.main();
      main.faults.beforeSet = () => {
        main.faults.beforeSet = () => {};
        main.put(jarCookie({ value: "from-the-site" }));
      };
      const result = yield* f.copy({ from: "work", sourceControls: allowed });
      expect(result?.units[0]?.outcome).toBe("busy");
      expect([...main.jar.values()].map((cookie) => cookie.value)).toEqual(["from-the-site"]);
    }),
  );

  it.effect(
    "never writes an unpartitioned stand-in for a partitioned cookie a navigation wrote first",
    () =>
      Effect.gen(function* () {
        const f = fillFixture();
        const partitionKey = { topLevelSite: "https://top.test", hasCrossSiteAncestor: false };
        const chip = jarCookie({ name: "chip", sameSite: "no_restriction", partitionKey });
        f.profile("work").put({ ...chip, value: "from-work" });
        const main = f.main();
        main.faults.beforeSet = () => {
          main.faults.beforeSet = () => {};
          main.put({ ...chip, value: "from-the-site" });
        };
        const result = yield* f.copy({ from: "work", sourceControls: allowed });
        expect(result?.units[0]?.outcome).toBe("busy");
        // The copy's value is gone, and no unpartitioned cookie took the slot's place.
        expect([...main.jar.values()]).toEqual([]);
      }),
  );

  it.effect("refuses a unit whose restore failed for the rest of the run", () =>
    Effect.gen(function* () {
      const f = fillFixture();
      f.profile("work").put(jarCookie());
      const main = f.main();
      main.faults.corruptNextSet = true;
      main.faults.onSet = () => {
        main.faults.failDeletes = true;
      };
      const first = yield* f.copy({ from: "work", sourceControls: allowed });
      expect(first?.units[0]?.outcome).toBe("restore-failed");
      main.faults.failDeletes = false;
      main.jar.clear();
      const again = yield* f.copy({ from: "work", sourceControls: allowed });
      expect(again?.units[0]?.outcome).toBe("restore-failed");
      expect(main.jar.size).toBe(0);
    }),
  );

  it.effect("imports into Main through a throwaway partition the importer writes instead", () =>
    Effect.gen(function* () {
      const f = fillFixture();
      const result = yield* f.copy({
        from: { importSourceId: "chrome", sourceProfileDirectory: "Default" },
      });
      expect(result?.units).toEqual([{ sites: ["github.com"], outcome: "copied" }]);
      expect(f.imports).toHaveLength(1);
      expect(f.imports[0]).toMatchObject({ persistent: false });
      expect(f.imports[0]?.scope.startsWith("scient-import-staging:")).toBe(true);
      expect(f.sessions.get(f.imports[0]!.scope)?.clearStorageData).toHaveBeenCalled();
      expect(f.main().jar.size).toBe(1);
    }),
  );
});

function fakeClock(at: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  return { [Symbol.dispose]: () => void vi.useRealTimers() };
}
