// @effect-diagnostics nodeBuiltinImport:off -- A temporary state folder for the refresh's record.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import { ACCOUNTS_DESKTOP_WRITE_CHECK_PATH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe, expect, vi } from "vite-plus/test";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";
import * as BrowserImport from "../../preview/BrowserImport/BrowserImport.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import { inJarTurn } from "../../scient/accounts/jarTurns.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as PreviewIpc from "./preview.ts";

/** One profile's jar, in memory, behind the DevTools protocol the desktop reads it through. */
const jar = vi.hoisted(() => new Map<string, { name: string; value: string; domain: string }>());
const cdp = vi.hoisted(() => async (method: string) => {
  if (method === "Network.getAllCookies")
    return {
      cookies: [...jar.values()].map((cookie) => ({
        ...cookie,
        path: "/",
        expires: -1,
        session: true,
        secure: true,
        httpOnly: true,
      })),
    };
  return {};
});
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  session: { fromPartition: vi.fn() },
  webContents: { fromId: vi.fn(() => null) },
  WebContentsView: class {
    webContents = {
      loadURL: async () => undefined,
      close: () => undefined,
      debugger: {
        attach: () => undefined,
        detach: () => undefined,
        isAttached: () => true,
        sendCommand: (method: string) => cdp(method),
      },
    };
  },
}));
vi.mock("../../scient/accounts/protectedStore.ts", () => ({
  undoEncryption: () => ({
    encrypt: (plain: string) => Buffer.from(plain),
    decrypt: (sealed: Buffer) => sealed.toString(),
  }),
}));

const theJar = {};
/** What this desktop's backend answers a write: no once the operation stops standing. */
const backend = { ok: true };
const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-refresh-turn-"));
const layer = Layer.mergeAll(
  Layer.succeed(PreviewManager.PreviewManager, {
    getBrowserSession: () => Effect.succeed(theJar),
  } as unknown as PreviewManager.PreviewManager["Service"]),
  Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
    stateDir,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
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
      Effect.sync(() =>
        HttpClientResponse.fromWeb(
          request,
          request.url.endsWith(ACCOUNTS_DESKTOP_WRITE_CHECK_PATH)
            ? new Response(JSON.stringify({ ok: backend.ok }), {
                headers: { "content-type": "application/json" },
              })
            : new Response("", { status: 500 }),
        ),
      ),
    ),
  ),
);

/** What the test and the import see of each other. */
const signals = {
  order: [] as string[],
  writing: Promise.withResolvers<void>(),
  finish: Promise.withResolvers<void>(),
};

describe("an agent's refresh writes in its jar's turn (round 6h, B)", () => {
  it.effect("keeps a sign-out waiting until the import has written", () =>
    Effect.scoped(
      Effect.gen(function* () {
        jar.clear();
        jar.set("sid", { name: "sid", value: "old", domain: ".example.com" });
        let listener: DesktopIpc.DesktopIpcHandleListener | undefined;
        const ipc = DesktopIpc.make(
          {
            removeHandler: vi.fn(),
            handle: (_channel, registered) => {
              listener = registered;
            },
            removeAllListeners: vi.fn(),
            on: vi.fn(),
          },
          () => Effect.succeed(true),
        );
        yield* ipc.handle(PreviewIpc.importBrowserCookies);
        const importing = listener!(
          { sender: { id: 7 } },
          {
            environmentId: "env-local",
            sourceId: "chrome",
            sourceProfileDirectory: "Profile 1",
            targetProfileId: "profile-lab",
            operationId: "op-refresh",
          },
        );
        yield* Effect.promise(() => signals.writing.promise);
        // A sign-out of the same jar, asked while the import holds it.
        const signOut = inJarTurn([theJar], async () => {
          signals.order.push("sign-out");
          jar.delete("sid");
        });
        for (let turn = 0; turn < 20; turn++) yield* Effect.promise(() => Promise.resolve());
        // regression: the sign-out ran between the refresh's check and its writes.
        expect(signals.order).toEqual([]);
        signals.finish.resolve();
        yield* Effect.promise(async () => {
          await importing;
          await signOut;
        });
        expect(signals.order).toEqual(["import", "sign-out"]);
      }),
    ).pipe(
      Effect.provideService(BrowserImport.BrowserImport, {
        importCookies: (input: { readonly mayWrite?: Effect.Effect<boolean> }) =>
          Effect.gen(function* () {
            // As BrowserImport.store does: asks at the write, then writes.
            expect(yield* input.mayWrite!).toBe(true);
            signals.writing.resolve();
            yield* Effect.promise(() => signals.finish.promise);
            jar.set("sid", { name: "sid", value: "new", domain: ".example.com" });
            signals.order.push("import");
            return { imported: 1, skipped: 0, skippedDomains: [] };
          }),
      } as unknown as BrowserImport.BrowserImport["Service"]),
      Effect.provide(layer),
    ),
  );
});
