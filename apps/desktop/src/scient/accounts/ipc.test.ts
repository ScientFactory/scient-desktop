// @effect-diagnostics nodeBuiltinImport:off -- Generate ephemeral synthetic values instead of credential fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  ACCOUNTS_DESKTOP_WRITE_CHECK_PATH,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type SessionCookie,
} from "@t3tools/contracts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
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
  signOutKept,
  undoDeadlines,
  withdrawFromMainHandler,
} from "./ipc.ts";
import { signOutMainSite } from "./mainFill.ts";
import { inJarTurn } from "./jarTurns.ts";
import { sealSignOut, setProfileGenerations, sweepSignOutSaves } from "./profileData.ts";
import { trackMainInserts } from "./mainInserts.ts";

vi.mock("./sessionCookies.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sessionCookies.ts")>()),
  withCookieDebugger: (
    session: { send: (method: string, params?: object) => Promise<unknown> },
    run: (send: (method: string, params?: object) => Promise<unknown>) => Promise<unknown>,
  ) => run(session.send),
}));

/** A protected store for the cases that keep an Undo; off, as on a computer without one. */
const protectedStore = vi.hoisted(() => ({ on: false }));
vi.mock("./protectedStore.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./protectedStore.ts")>();
  return {
    ...actual,
    undoEncryption: () =>
      protectedStore.on
        ? {
            encrypt: (plain: string) => Buffer.from(plain),
            decrypt: (sealed: Buffer) => sealed.toString(),
          }
        : actual.undoEncryption(),
  };
});

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

const cookieValues = { last: "" };
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
    executeJavaScriptInIsolatedWorld: async (worldId: number) => worldId === 999,
    // A filled password listens for the page's "Stay signed in?" step.
    on: () => undefined,
    removeListener: () => undefined,
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
                  name: "session",
                  domain: ".example.test",
                  expirationDate: 2000,
                  httpOnly: true,
                  // A new value at every read, as a session the site rotates.
                  value: (cookieValues.last = NodeCrypto.randomBytes(16).toString("hex")),
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
        path: "/login",
        step: "password",
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

it.effect("carries a username step to the next password step, and never sends it alone", () =>
  Effect.gen(function* () {
    const f = fixture();
    const username = NodeCrypto.randomBytes(16).toString("hex");
    const password = NodeCrypto.randomBytes(16).toString("hex");
    const step = (patch: object) =>
      f.run(
        forwardCapturedSignIn(f.guestEvent, {
          url: "https://example.test",
          path: "/login",
          step: "password",
          username: "",
          password,
          ...patch,
        }),
      );
    yield* step({ step: "username", username, password: "" });
    expect(f.sent).toEqual([]);
    yield* step({ path: "/password" });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ path: "/password", usernameFrom: "earlier-step" });
    expect((f.sent[0] as { username: string }).username === username).toBe(true);
    // Used once: the next password step has nothing to carry.
    yield* step({});
    expect(f.sent[1]).toMatchObject({ username: "", usernameFrom: "form" });
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
    const read = () =>
      f.run(cookieMetadata({ profileId: "work", environmentId: "remote" }, f.mainEvent));
    const first = yield* read();
    // Its name and a fingerprint of its value, never the value: a rotation shows (round 6c).
    expect(first).toEqual([
      {
        domain: ".example.test",
        httpOnly: true,
        expires: 2000,
        name: "session",
        path: "/",
        digest: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
    ]);
    expect(JSON.stringify(first)).not.toContain(cookieValues.last);
    const second = yield* read();
    expect(second?.[0]?.digest).not.toBe(first?.[0]?.digest);
    expect(yield* f.run(cookieMetadata({ profileId: "default" }, f.guestEvent))).toBeNull();
    expect(yield* f.run(cookieMetadata({ profileId: "\u0000" }, f.mainEvent))).toBeNull();
    f.failCookieRead();
    expect(yield* f.run(cookieMetadata({ profileId: "work" }, f.mainEvent))).toBeNull();
  }),
);

const fillInput = (input: Record<string, unknown>) => ({ mode: "fill", skipSites: [], ...input });

/** Jars kept in memory behind a fake debugger, with faults a test can set. */
function fillFixture(
  stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-main-copies-")),
) {
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
  /** This desktop's own backend (round 6f): what it answers when a write asks. */
  const backend = { ok: true, checks: [] as unknown[] };
  const layer = Layer.mergeAll(
    Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
      primary: Effect.succeed({
        currentConfig: Effect.succeedSome({ httpBaseUrl: new URL("http://127.0.0.1:4100") }),
      }),
    } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]),
    Layer.succeed(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth, {
      getBearerToken: Effect.succeed("desktop-session"),
      forgetBearerToken: Effect.void,
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const check = request.url.endsWith(ACCOUNTS_DESKTOP_WRITE_CHECK_PATH);
          if (check && request.body._tag === "Uint8Array")
            backend.checks.push(JSON.parse(new TextDecoder().decode(request.body.body)));
          return HttpClientResponse.fromWeb(
            request,
            check
              ? new Response(JSON.stringify({ ok: backend.ok }), {
                  headers: { "content-type": "application/json" },
                })
              : new Response("", { status: 500 }),
          );
        }),
      ),
    ),
    Layer.succeed(
      DesktopEnvironment.DesktopEnvironment,
      // Only the state folder: Main's copy records live there.
      { stateDir, path: NodePath } as unknown as DesktopEnvironment.DesktopEnvironment["Service"],
    ),
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
          // A mixed Windows jar: one cookie written, three app-bound rows and one corrupt left out.
          return {
            imported: 1,
            skipped: 4,
            skippedDomains: ["google.com"],
            skippedByReason: {
              appBoundEncryption: 3,
              decryptFailed: 1,
              partitionUnsupported: 0,
              writeFailed: 0,
            },
          };
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
    backend,
    main: () => sessionFor(PRIMARY_LOCAL_ENVIRONMENT_ID),
    profile,
    imports,
    sessions,
    copy: (input: Record<string, unknown>, sender: unknown = event) =>
      fillMainHandler(fillInput(input), sender as never).pipe(Effect.provide(layer)),
    stateDir,
    signOutMain: (site: string) =>
      signOutMainSite(site, PRIMARY_LOCAL_ENVIRONMENT_ID).pipe(Effect.provide(layer)),
    /** The sign-out with Undo (round 6c), for Main too. */
    signOutKept: (profileId: string, site: string, generation?: number) =>
      signOutKept(
        {
          profileId,
          site,
          operationId: "op-out",
          ...(generation === undefined ? {} : { generation }),
        },
        event as never,
      ).pipe(Effect.provide(layer)),
    undoDeadlines: (deadlines: Record<string, string | null>) =>
      undoDeadlines({ deadlines }, event as never).pipe(Effect.provide(layer)),
    withdraw: (from: string, heldOnly?: true) =>
      withdrawFromMainHandler(heldOnly ? { from, heldOnly } : { from }, event as never).pipe(
        Effect.provide(layer),
      ),
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
    onSet: () => {},
  };
  const cookies = Object.assign(new NodeEvents.EventEmitter(), {
    flushStore: vi.fn(async () => undefined),
    // Electron's own cookie API, which Accounts' Sign out uses.
    get: vi.fn(async () => [...jar.values()].map(electronCookie)),
    remove: vi.fn(async (_url: string, name: string) => {
      for (const [key, cookie] of jar) if (cookie.name === name) jar.delete(key);
    }),
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
  const reads: { count: number; after?: (() => void) | undefined } = { count: 0 };
  const send = async (method: string, params?: { cookies?: Array<Record<string, never>> }) => {
    if (method === "Network.getAllCookies") {
      reads.count++;
      const after = reads.after;
      reads.after = undefined;
      after?.();
    }
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
    reads,
    put,
    send,
    clearStorageData: vi.fn(async () => jar.clear()),
  };
}

describe("withdrawFromMain", () => {
  it.effect("takes back only what a restricted profile's copies still hold in Main", () =>
    Effect.gen(function* () {
      const f = fillFixture();
      f.profile("work").put(jarCookie());
      f.profile("work").put(jarCookie({ domain: ".overleaf.com", value: "overleaf" }));
      f.profile("home").put(jarCookie({ domain: ".gitlab.com", value: "home" }));
      yield* f.copy({ from: "work" });
      yield* f.copy({ from: "home" });
      expect(f.main().jar.size).toBe(3);
      // The site rotated Overleaf's session in Main since: it is Main's own now.
      f.main().put(jarCookie({ domain: ".overleaf.com", value: "rotated" }));
      // Listing what Main holds from it, for other computers first, removes nothing.
      expect(yield* f.withdraw("work", true)).toEqual({
        units: [["github.com"], ["overleaf.com"]],
      });
      expect(f.main().jar.size).toBe(3);
      expect(yield* f.withdraw("work")).toEqual({ units: [["github.com"]] });
      expect([...f.main().jar.values()].map(({ domain, value }) => [domain, value])).toEqual([
        [".overleaf.com", "rotated"],
        [".gitlab.com", "home"],
      ]);
      // Taken back once: nothing is left to take, and the source profile is never touched.
      expect(yield* f.withdraw("work")).toEqual({ units: [] });
      expect(f.profile("work").jar.size).toBe(2);
    }),
  );

  it.effect("never takes back a session Main had before an identical copy", () =>
    Effect.gen(function* () {
      const f = fillFixture();
      // Main was signed in on its own, to the same session the profile holds.
      f.main().put(jarCookie(), true);
      f.profile("work").put(jarCookie());
      const filled = yield* f.copy({ from: "work" });
      expect(filled?.units[0]?.outcome).toBe("same");
      expect(yield* f.withdraw("work")).toEqual({ units: [] });
      expect(f.main().jar.size).toBe(1);
    }),
  );

  it.effect("keeps the first source's copy when an identical second source is restricted", () =>
    Effect.gen(function* () {
      const f = fillFixture();
      f.profile("work").put(jarCookie());
      f.profile("home").put(jarCookie());
      expect((yield* f.copy({ from: "work" }))?.units[0]?.outcome).toBe("copied");
      expect((yield* f.copy({ from: "home" }))?.units[0]?.outcome).toBe("same");
      expect(yield* f.withdraw("home")).toEqual({ units: [] });
      expect(f.main().jar.size).toBe(1);
      expect(yield* f.withdraw("work")).toEqual({ units: [["github.com"]] });
      expect(f.main().jar.size).toBe(0);
    }),
  );

  it.effect(
    "keeps copy records on disk, digests only, and withdraws from them after a restart",
    () =>
      Effect.gen(function* () {
        const first = fillFixture();
        first.profile("work").put(jarCookie({ value: "work-session" }));
        yield* first.copy({ from: "work" });
        const file = NodePath.join(first.stateDir, "scient", "main-copies.json");
        const text = NodeFS.readFileSync(file, "utf8");
        expect(text).not.toContain("work-session");
        expect(JSON.parse(text)).toEqual({
          [PRIMARY_LOCAL_ENVIRONMENT_ID]: [
            { from: "work", sites: ["github.com"], fingerprint: expect.any(String) },
          ],
        });
        if ((yield* HostProcess.Platform) !== "win32")
          expect(NodeFS.statSync(file).mode & 0o777).toBe(0o600);
        // A new run reads the records back from the file, with Main as the copy left it.
        const restarted = fillFixture(first.stateDir);
        restarted.main().put(jarCookie({ value: "work-session" }), true);
        expect(yield* restarted.withdraw("work")).toEqual({ units: [["github.com"]] });
        expect(restarted.main().jar.size).toBe(0);
        expect(JSON.parse(NodeFS.readFileSync(file, "utf8"))).toEqual({
          [PRIMARY_LOCAL_ENVIRONMENT_ID]: [],
        });
      }),
  );
});

describe("fillMain", () => {
  it.effect("refuses other senders, and Main or Incognito as a source", () =>
    Effect.gen(function* () {
      const f = fillFixture();
      f.profile("work").put(jarCookie());
      expect(yield* f.copy({ from: "work" }, { sender: { id: 2 } })).toBeNull();
      for (const refused of [{ from: "default" }, { from: "incognito" }])
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
        const result = yield* f.copy({ from: "work" });
        expect(result).toEqual({
          units: [{ sites: ["github.com"], outcome: "copied" }],
          unsupported: 0,
        });
        expect(JSON.stringify(result)).not.toContain(secret);
        expect([...f.main().jar.values()]).toEqual(before);
        expect([...f.profile("work").jar.values()]).toEqual(before);
      }),
  );

  it.effect("reads Main's jar once for units it leaves alone, and again after a change", () =>
    Effect.gen(function* () {
      const f = fillFixture();
      for (const domain of [".github.com", ".gitlab.com", ".overleaf.com"]) {
        f.profile("work").put(jarCookie({ domain }));
        f.main().put(jarCookie({ domain }), true);
      }
      const first = yield* f.copy({ from: "work" });
      expect(first?.units.map(({ outcome }) => outcome)).toEqual(["same", "same", "same"]);
      expect(f.main().reads.count).toBe(1);
      // A page writing during the batch is a change event: the next unit reads the jar afresh.
      f.main().reads.count = 0;
      f.main().reads.after = () => f.main().put(jarCookie({ domain: ".example.com" }));
      yield* f.copy({ from: "work" });
      expect(f.main().reads.count).toBe(2);
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

  // The copy-race rules are tested in shared applyUnit and on real Electron by the qualify
  // harness; this one proves Electron's change events reach the copy as foreign writes.
  it.effect("passes a site's insert during a copy to the restore, which keeps it", () =>
    Effect.gen(function* () {
      const f = fillFixture();
      f.profile("work").put(jarCookie());
      const main = f.main();
      main.faults.corruptNextSet = true;
      main.faults.onSet = () => {
        main.faults.onSet = () => {};
        main.put(jarCookie({ name: "page", value: "site" }));
      };
      const result = yield* f.copy({ from: "work" });
      expect(result?.units[0]?.outcome).toBe("failed");
      expect([...main.jar.values()].map((cookie) => cookie.name)).toEqual(["page"]);
    }),
  );

  it.effect("refuses a unit whose restore failed until the user signs out of it in Main", () =>
    Effect.gen(function* () {
      const f = fillFixture();
      f.profile("work").put(jarCookie());
      const main = f.main();
      main.faults.corruptNextSet = true;
      main.faults.onSet = () => {
        main.faults.failDeletes = true;
      };
      const first = yield* f.copy({ from: "work" });
      expect(first?.units[0]?.outcome).toBe("restore-failed");
      main.faults.failDeletes = false;
      main.jar.clear();
      const again = yield* f.copy({ from: "work" });
      expect(again?.units[0]?.outcome).toBe("restore-failed");
      expect(main.jar.size).toBe(0);
      // The user's own Sign out of the site in Main lets copies write it again.
      expect(yield* f.signOutMain("github.com")).toBe(true);
      const afterSignOut = yield* f.copy({ from: "work" });
      expect(afterSignOut?.units[0]?.outcome).toBe("copied");
    }),
  );

  it.effect(
    "writes an operation's part into the data it was done in, whatever Clear did since",
    () =>
      Effect.gen(function* () {
        const f = fillFixture();
        f.profile("work").put(jarCookie());
        // Cleared after the sign-out was decided: the profile opens in generation 1 now.
        setProfileGenerations(PRIMARY_LOCAL_ENVIRONMENT_ID, { work: 1 });
        try {
          expect(yield* f.signOutKept("work", "github.com", 0)).toMatchObject({ signedOut: true });
          // Generation 0's jar, where it was decided, is the one signed out (round 6d).
          expect(f.profile("work").jar.size).toBe(0);
        } finally {
          setProfileGenerations(PRIMARY_LOCAL_ENVIRONMENT_ID, {});
        }
      }),
  );

  it.effect("signs nothing out when its own backend says, at the write, it no longer stands", () =>
    Effect.gen(function* () {
      const f = fillFixture();
      f.profile("work").put(jarCookie());
      // Revoked after the claim: the desktop asks its own backend at the moment of the write.
      f.backend.ok = false;
      // regression: the desktop wrote on the renderer's earlier claim alone.
      expect(yield* f.signOutKept("work", "github.com")).toBeNull();
      expect(f.profile("work").jar.size).toBe(1);
      expect(f.backend.checks).toEqual([{ operationId: "op-out", phase: "do" }]);
      f.backend.ok = true;
      expect(yield* f.signOutKept("work", "github.com")).toMatchObject({ signedOut: true });
      expect(f.profile("work").jar.size).toBe(0);
    }),
  );

  it("runs a jar's writes one at a time, each with its own check", async () => {
    const jar = {};
    const order: string[] = [];
    let release = () => undefined as void;
    const first = inJarTurn([jar], async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => (release = resolve));
      order.push("first:end");
    });
    const second = inJarTurn([jar], async () => void order.push("second"));
    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it.effect("keeps a sign-out's save across a restart until its receipt's Undo ends", () =>
    Effect.gen(function* () {
      const f = fillFixture();
      sealSignOut(f.stateDir, "op-out", [jarCookie()], (plain) => Buffer.from(plain));
      const save = NodePath.join(f.stateDir, "scient-sign-outs", "op-out.bin");
      const made = NodeFS.statSync(save).mtimeMs;
      // Its other desktops are still signing out: no deadline yet.
      expect(yield* f.undoDeadlines({ "op-out": null })).toBe(true);
      // regression: a restart two hours on swept it by its age, before its Undo had begun.
      sweepSignOutSaves(f.stateDir, made + 2 * 60 * 60 * 1000);
      expect(NodeFS.existsSync(save)).toBe(true);
      const until = DateTime.formatIso(DateTime.makeUnsafe(made + 3 * 60 * 60 * 1000));
      expect(yield* f.undoDeadlines({ "op-out": until })).toBe(true);
      sweepSignOutSaves(f.stateDir, Date.parse(until) - 1);
      expect(NodeFS.existsSync(save)).toBe(true);
      sweepSignOutSaves(f.stateDir, Date.parse(until) + 1);
      expect(NodeFS.existsSync(save)).toBe(false);
    }),
  );

  it.effect("lets copies write a site again after Main's sign-out with Undo, as its own did", () =>
    Effect.gen(function* () {
      const f = fillFixture();
      f.profile("work").put(jarCookie());
      const main = f.main();
      main.faults.corruptNextSet = true;
      main.faults.onSet = () => {
        main.faults.failDeletes = true;
      };
      expect((yield* f.copy({ from: "work" }))?.units[0]?.outcome).toBe("restore-failed");
      main.faults.failDeletes = false;
      main.jar.clear();
      // Under Main's lock, kept for its Undo, and the site starts afresh for copies.
      expect(yield* f.signOutKept("default", "github.com")).toMatchObject({ signedOut: true });
      expect((yield* f.copy({ from: "work" }))?.units[0]?.outcome).toBe("copied");
    }),
  );

  it.effect("imports into Main through a throwaway partition the importer writes instead", () =>
    Effect.gen(function* () {
      const f = fillFixture();
      const result = yield* f.copy({
        from: { importSourceId: "chrome", sourceProfileDirectory: "Default" },
      });
      expect(result?.units).toEqual([{ sites: ["github.com"], outcome: "copied" }]);
      // The import's cookie rows come back beside the copy's units, never merged into them.
      expect(result?.importSummary).toEqual({
        imported: 1,
        skipped: 4,
        skippedByReason: {
          appBoundEncryption: 3,
          decryptFailed: 1,
          partitionUnsupported: 0,
          writeFailed: 0,
        },
      });
      expect(f.imports).toHaveLength(1);
      expect(f.imports[0]).toMatchObject({ persistent: false });
      expect(f.imports[0]?.scope.startsWith("scient-import-staging:")).toBe(true);
      expect(f.sessions.get(f.imports[0]!.scope)?.clearStorageData).toHaveBeenCalled();
      expect(f.main().jar.size).toBe(1);
    }),
  );

  it.effect("checks an agent's refresh of Main in Main's turn before it writes (6i)", () =>
    Effect.gen(function* () {
      const f = fillFixture();
      const refresh = {
        from: { importSourceId: "chrome", sourceProfileDirectory: "Default" },
        operationId: "op-main",
      };
      // Stopped while the browser asked: Main is as it was.
      f.backend.ok = false;
      // regression: Main's fill carried no operation, so nothing checked it as it wrote.
      expect(yield* f.copy(refresh)).toBeNull();
      expect(f.backend.checks).toEqual([{ operationId: "op-main", phase: "do" }]);
      expect(f.main().jar.size).toBe(0);
      // Standing, it writes.
      f.backend.ok = true;
      const result = yield* f.copy(refresh);
      expect(result?.units).toEqual([{ sites: ["github.com"], outcome: "copied" }]);
      expect(f.main().jar.size).toBe(1);
    }),
  );
});

function fakeClock(at: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  return { [Symbol.dispose]: () => void vi.useRealTimers() };
}
