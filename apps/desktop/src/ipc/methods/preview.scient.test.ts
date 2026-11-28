import { it } from "@effect/vitest";
import { ACCOUNTS_DESKTOP_WRITE_CHECK_PATH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe, expect, vi } from "vite-plus/test";

import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";
import * as BrowserImport from "../../preview/BrowserImport/BrowserImport.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { setProfileGenerations } from "../../scient/accounts/profileData.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as PreviewIpc from "./preview.ts";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  session: { fromPartition: vi.fn() },
  webContents: { fromId: vi.fn(() => null) },
}));

const imported: Array<string> = [];
/** This desktop's own backend (round 6f): what it answers when an agent's write asks. */
const backend = { ok: true, checks: [] as unknown[], wrote: [] as boolean[] };
const ownBackend = Layer.mergeAll(
  // The jar a refresh writes in, and the state folder its record goes to.
  Layer.succeed(PreviewManager.PreviewManager, {
    getBrowserSession: () => Effect.succeed({}),
  } as unknown as PreviewManager.PreviewManager["Service"]),
  Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
    stateDir: "/private/tmp/scient-preview-refresh-test",
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
);

describe("an agent's refresh writes into its own generation (round 6e)", () => {
  it.effect("imports into the generation named, not the one a Clear opened since", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scopes = imported;
        imported.length = 0;
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
        // Cleared after the refresh was decided: Lab opens in generation 1 now.
        setProfileGenerations("env-local", { "profile-lab": 1 });
        const invoke = (extra: object) =>
          Effect.promise(async () =>
            listener!(
              { sender: { id: 7 } },
              {
                environmentId: "env-local",
                sourceId: "chrome",
                sourceProfileDirectory: "Profile 1",
                targetProfileId: "profile-lab",
                ...extra,
              },
            ),
          );
        try {
          yield* invoke({ targetGeneration: 0 });
          yield* invoke({});
        } finally {
          setProfileGenerations("env-local", {});
        }
        // regression: the refresh wrote into generation 1 while its backups were generation 0's.
        expect(scopes[0]).toBe(
          PreviewIpc.resolvePartitionScope("env-local", "profile-lab", 0).scope,
        );
        // The person's own import goes where the profile is now.
        expect(scopes[1]).toBe(
          PreviewIpc.resolvePartitionScope("env-local", "profile-lab", 1).scope,
        );
        expect(scopes[0]).not.toBe(scopes[1]);
      }),
    ).pipe(
      Effect.provideService(BrowserImport.BrowserImport, {
        importCookies: ({ scope }: { readonly scope: string }) =>
          Effect.sync(() => {
            imported.push(scope);
            return { imported: 1, skipped: 0, skippedDomains: [] };
          }),
      } as unknown as BrowserImport.BrowserImport["Service"]),
      Effect.provide(ownBackend),
    ),
  );

  it.effect(
    "asks this desktop's backend, as an agent's refresh writes, whether it stands (6f)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
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
          backend.ok = false;
          backend.checks.length = 0;
          backend.wrote.length = 0;
          yield* Effect.promise(async () =>
            listener!(
              { sender: { id: 7 } },
              {
                environmentId: "env-local",
                sourceId: "chrome",
                sourceProfileDirectory: "Profile 1",
                targetProfileId: "profile-lab",
                operationId: "op-refresh",
              },
            ),
          );
          // regression: the import wrote after the agent's access was gone, unasked.
          expect(backend.checks).toEqual([{ operationId: "op-refresh", phase: "do" }]);
          expect(backend.wrote).toEqual([false]);
        }),
      ).pipe(
        Effect.provideService(BrowserImport.BrowserImport, {
          importCookies: (input: { readonly mayWrite?: Effect.Effect<boolean> }) =>
            Effect.gen(function* () {
              // As BrowserImport.store does, at the write.
              backend.wrote.push(input.mayWrite ? yield* input.mayWrite : true);
              return { imported: 0, skipped: 0, skippedDomains: [] };
            }),
        } as unknown as BrowserImport.BrowserImport["Service"]),
        Effect.provide(ownBackend),
      ),
  );
});
