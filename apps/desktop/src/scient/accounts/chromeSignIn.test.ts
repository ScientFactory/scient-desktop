// @effect-diagnostics nodeBuiltinImport:off -- The state folder path only; nothing is written there.
import * as NodePath from "node:path";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  BrowserProfileId,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopFillMainResult,
  type SessionCookie,
} from "@t3tools/contracts";
import type * as Electron from "electron";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { PreviewManager } from "../../preview/Manager.ts";
import { chromeSignIn } from "./chromeSignIn.ts";

const state = vi.hoisted(() => ({
  read: { units: [] as string[][], cookies: [] as unknown[] },
  main: null as DesktopFillMainResult | null,
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
vi.mock("./chromeWindow.ts", () => ({
  canQuitWindow: () => true,
  endSignInWindow: () => true,
  installedChromiumBrowsers: () => [{ name: "Edge", executable: "/synthetic/edge" }],
  signInInWindow: async () => ({ outcome: "read", ...state.read }),
}));
vi.mock("./sessionCookies.ts", () => ({
  withCookieDebugger: (
    session: { send: (method: string, params?: object) => Promise<unknown> },
    run: (send: (method: string, params?: object) => Promise<unknown>) => Promise<unknown>,
  ) => run(session.send),
}));
vi.mock("./mainFill.ts", async (importOriginal) => {
  // A mock factory runs before this file's own imports are bound.
  const Effect = await import("effect/Effect");
  return {
    ...(await importOriginal<typeof import("./mainFill.ts")>()),
    fillMainStaged: (
      _environmentId: string,
      _input: unknown,
      stage: (scope: string) => Effect.Effect<unknown>,
    ) => stage("staging").pipe(Effect.as(state.main)),
  };
});

const cookie = (domain: string): SessionCookie => ({
  name: "session",
  value: "synthetic",
  domain,
  hostOnly: false,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
});

const listed = (...valid: number[]) =>
  new Response(
    JSON.stringify([
      "gaia.l.a.r",
      valid.map((flag, index) => [
        "gaia.l.a",
        1,
        "Name",
        `${index}@example.com`,
        "",
        1,
        1,
        0,
        0,
        flag,
      ]),
    ]),
  );

/** A profile's jar behind a fake debugger, and Google's answers to it in order. */
function profile(
  answers: ReadonlyArray<Response | Error>,
  { failWrites = false, signedIn = false } = {},
) {
  const written: unknown[] = [];
  const asked: string[] = [];
  return {
    written,
    asked,
    send: async (method: string, params?: { cookies?: unknown[] }) => {
      if (method !== "Network.setCookies") throw new Error(`Unexpected ${method}`);
      if (failWrites) throw new Error("Synthetic write failure");
      written.push(...(params?.cookies ?? []));
      return {};
    },
    cookies: {
      // Google is asked only about a profile holding a cookie of accounts.google.com.
      get: async () => (signedIn || written.length > 0 ? [{ name: "synthetic" }] : []),
      flushStore: async () => undefined,
    },
    fetch: async (url: string) => {
      const answer = answers[asked.length] ?? answers.at(-1)!;
      asked.push(url);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

function run(profileId: string, target: ReturnType<typeof profile>) {
  const scopes: Array<string | undefined> = [];
  const staging = profile([]);
  const layer = Layer.mergeAll(
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      stateDir: "/synthetic",
      path: NodePath,
    } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
    Layer.mock(PreviewManager)({
      isBrowserPartition: () => true,
      getBrowserSession: (scope) => {
        scopes.push(scope);
        return Effect.succeed(
          (scope === "staging" ? staging : target) as unknown as Electron.Session,
        );
      },
    }),
  );
  return chromeSignIn({
    environmentId: EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID),
    profileId: BrowserProfileId.make(profileId),
    url: "https://accounts.google.com/",
    ...(profileId === "default" ? { main: { mode: "fill-or-replace", skipSites: [] } } : {}),
  }).pipe(
    Effect.provide(layer),
    Effect.map((result) => ({ result, scopes, staging })),
  );
}

const googleWindow = () => {
  state.read = {
    units: [["google.com"], ["overleaf.com"]],
    cookies: [cookie(".google.com"), cookie("accounts.google.com"), cookie(".overleaf.com")],
  };
};

it.effect("says Google accepted a copy only when Google lists a working account", () =>
  Effect.gen(function* () {
    googleWindow();
    const accepted = profile([listed(0, 1)]);
    expect((yield* run("work", accepted)).result).toEqual({
      outcome: "copied",
      browser: "Edge",
      sites: ["google.com", "overleaf.com"],
      google: "accepted",
    });
    expect(accepted.written).toHaveLength(3);
    // Cookies written, but Google turns every account down, or lists none.
    for (const answer of [listed(0, 0), listed()]) {
      const target = profile([answer]);
      expect((yield* run("work", target)).result).toMatchObject({
        outcome: "copied",
        google: "rejected",
      });
      expect(target.written).toHaveLength(3);
    }
    // Google couldn't be asked: never reported as accepted.
    for (const answer of [new Error("Synthetic offline"), new Response("<html>")]) {
      expect((yield* run("work", profile([answer]))).result).toMatchObject({
        outcome: "copied",
        google: "unknown",
      });
    }
  }),
);

it.effect("tells a copy over a session Google already accepted from a fresh one", () =>
  Effect.gen(function* () {
    googleWindow();
    const target = profile([listed(1), listed(1)], { signedIn: true });
    expect((yield* run("work", target)).result).toMatchObject({
      google: "accepted",
      googleHeldBefore: true,
    });
    expect(target.asked).toHaveLength(2);
  }),
);

it.effect("asks Google nothing when the window brought no Google sign-in", () =>
  Effect.gen(function* () {
    state.read = { units: [["github.com"]], cookies: [cookie(".github.com")] };
    const target = profile([listed(1)]);
    const { result } = yield* run("work", target);
    expect(result).toEqual({ outcome: "copied", browser: "Edge", sites: ["github.com"] });
    expect(target.asked).toEqual([]);
  }),
);

it.effect("fails, rather than claiming a copy, when the profile can't be written", () =>
  Effect.gen(function* () {
    googleWindow();
    const target = profile([listed(1)], { failWrites: true });
    expect((yield* run("work", target)).result).toEqual({ outcome: "failed", browser: "Edge" });
  }),
);

it.effect("keeps Main's conflicts in the result and asks Google only when Main took its unit", () =>
  Effect.gen(function* () {
    googleWindow();
    state.main = {
      units: [
        { sites: ["google.com"], outcome: "conflict" },
        { sites: ["overleaf.com"], outcome: "copied" },
      ],
      unsupported: 0,
    };
    const held = profile([listed(1)]);
    const first = yield* run("default", held);
    expect(first.result).toEqual({
      outcome: "copied",
      browser: "Edge",
      sites: ["google.com", "overleaf.com"],
      main: state.main,
    });
    expect(held.asked).toEqual([]);
    // The window's cookies reach Main only through the staging partition.
    expect(first.staging.written).toHaveLength(3);
    expect(held.written).toEqual([]);
    state.main = { units: [{ sites: ["google.com"], outcome: "copied" }], unsupported: 0 };
    const taken = profile([listed(0)], { signedIn: true });
    const second = yield* run("default", taken);
    expect(second.result).toMatchObject({ outcome: "copied", google: "rejected" });
    expect(second.result).not.toHaveProperty("googleHeldBefore");
    expect(taken.asked).toHaveLength(1);
    expect(second.scopes[0]).toBe(PRIMARY_LOCAL_ENVIRONMENT_ID);
    state.main = null;
    expect((yield* run("default", profile([listed(1)]))).result).toEqual({
      outcome: "failed",
      browser: "Edge",
    });
  }),
);
