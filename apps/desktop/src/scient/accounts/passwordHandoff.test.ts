import { it } from "@effect/vitest";
import { ACCOUNTS_DESKTOP_PASSWORDS_PATH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe, expect, vi } from "vite-plus/test";

import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";

const synthetic = vi.hoisted(() => ({
  csv: "name,url,username,password\nSite,https://a.test,ada,x",
}));
vi.mock("./browserPasswords.ts", async () => {
  const Effect = await import("effect/Effect");
  return {
    readBrowserPasswords: () => Effect.succeed({ content: synthetic.csv, skipped: 1 }),
  };
});

const { importBrowserPasswordsHere } = await import("./ipc.ts");

describe("a browser's passwords go from the desktop to its own backend (round 6f)", () => {
  it.effect("hands them over with its own session; the page gets only the counts", () =>
    Effect.gen(function* () {
      const sent: Array<{ url: string; authorization?: string; body: unknown }> = [];
      let status = 200;
      const frame = {};
      const contents = { id: 1, mainFrame: frame, isDestroyed: () => false };
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
              const body = request.body;
              sent.push({
                url: request.url,
                ...(request.headers.authorization
                  ? { authorization: request.headers.authorization }
                  : {}),
                body:
                  body._tag === "Uint8Array"
                    ? JSON.parse(new TextDecoder().decode(body.body))
                    : null,
              });
              return HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify({ result: { created: 2, updated: 0, skipped: 0 } }), {
                  status,
                  headers: { "content-type": "application/json" },
                }),
              );
            }),
          ),
        ),
        Layer.mock(ElectronWindow)({
          appWindows: Effect.succeed([
            {
              isDestroyed: () => false,
              webContents: contents,
            } as unknown as Electron.BrowserWindow,
          ]),
        }),
      );
      const event = { sender: { id: 1 }, senderFrame: frame } as never;
      const run = (input: unknown) =>
        // The browser's own reading is mocked away: only the handoff runs here.
        // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
        importBrowserPasswordsHere(input, event).pipe(
          Effect.provide(layer),
        ) as Effect.Effect<unknown>;
      const reply = yield* run({
        sourceId: "chrome",
        directory: "Default",
        profileId: "profile-lab",
        operationId: "op-1",
      });
      // regression: the page was handed the raw CSV and chose where to send it.
      expect(reply).toEqual({ result: { created: 2, updated: 0, skipped: 0 }, skipped: 1 });
      expect(JSON.stringify(reply)).not.toContain("https://a.test");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        url: `http://127.0.0.1:4100${ACCOUNTS_DESKTOP_PASSWORDS_PATH}`,
        authorization: "Bearer desktop-session",
        body: {
          format: "chrome",
          content: synthetic.csv,
          origin: "browser",
          profileId: "profile-lab",
          operationId: "op-1",
        },
      });
      // No answer from its backend is no import: nothing is handed anywhere else.
      status = 401;
      expect(yield* run({ sourceId: "chrome", directory: "Default" })).toBeNull();
    }),
  );
});
