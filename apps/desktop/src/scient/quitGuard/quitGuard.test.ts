import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

const dialog = vi.hoisted(() => ({ asked: 0 }));
vi.mock("electron", () => ({
  dialog: {
    showMessageBox: () => {
      dialog.asked += 1;
      return Promise.resolve({ response: 1 });
    },
  },
}));

import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";
import {
  confirmQuitStopsRunningWork,
  installRunningWorkReader,
  quitPrompt,
  readRunningWork,
  setRunningWork,
} from "./quitGuard.ts";

const server = (
  answer: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
) => Layer.succeed(HttpClient.HttpClient, HttpClient.make(answer));

const status = (request: HttpClientRequest.HttpClientRequest, code: number) =>
  HttpClientResponse.fromWeb(request, new Response(null, { status: code }));

const instance = (id: string, ready: boolean) =>
  ({
    id: DesktopBackendPool.BackendInstanceId(id),
    snapshot: Effect.succeed({ ready }),
    currentConfig: Effect.succeedSome({ httpBaseUrl: new URL("http://127.0.0.1:3773/") }),
  }) as unknown as DesktopBackendManager.DesktopBackendInstance;

const read = (input: {
  readonly instances: ReadonlyArray<DesktopBackendManager.DesktopBackendInstance>;
  readonly http: Layer.Layer<HttpClient.HttpClient>;
  readonly tokens?: string[];
}) => {
  const tokens = input.tokens ?? ["token"];
  let issued = 0;
  return readRunningWork.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(DesktopBackendPool.DesktopBackendPool, {
          list: Effect.succeed(input.instances),
        }),
        Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth, {
          getBearerToken: Effect.sync(() => tokens[Math.min(issued, tokens.length - 1)]!),
          forgetBearerToken: Effect.sync(() => void (issued += 1)),
        }),
        input.http,
      ),
    ),
  );
};

const primary = (ready: boolean) => instance(DesktopBackendManager.PRIMARY_INSTANCE_ID, ready);

describe("readRunningWork", () => {
  it.effect("reads the count from this computer's server when the person quits", () =>
    Effect.gen(function* () {
      const counted = server((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ count: 2 }))),
      );
      assert.equal(yield* read({ instances: [primary(true)], http: counted }), 2);
    }),
  );

  it.effect("knows nothing runs on a backend that is not ready", () =>
    Effect.gen(function* () {
      const unasked = server(() => Effect.die("no server to ask"));
      assert.equal(
        yield* read({ instances: [primary(false), instance("wsl:Ubuntu", false)], http: unasked }),
        0,
      );
    }),
  );

  it.effect("counts a live WSL backend it cannot ask as unknown", () =>
    Effect.gen(function* () {
      const counted = server((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ count: 0 }))),
      );
      assert.isNull(
        yield* read({ instances: [primary(true), instance("wsl:Ubuntu", true)], http: counted }),
      );
    }),
  );

  it.effect("renews an expired session once and reads the count", () =>
    Effect.gen(function* () {
      const renewed = server((request) =>
        Effect.succeed(
          request.headers.authorization === "Bearer fresh"
            ? HttpClientResponse.fromWeb(request, Response.json({ count: 1 }))
            : status(request, 401),
        ),
      );
      assert.equal(
        yield* read({ instances: [primary(true)], http: renewed, tokens: ["expired", "fresh"] }),
        1,
      );
    }),
  );

  it.effect("counts a refused, failing or late answer as unknown", () =>
    Effect.gen(function* () {
      const refused = server((request) => Effect.succeed(status(request, 401)));
      assert.isNull(yield* read({ instances: [primary(true)], http: refused }));
      // A failing server's body is never read as a count.
      const failing = server((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ count: 0 }, { status: 500 })),
        ),
      );
      assert.isNull(yield* read({ instances: [primary(true)], http: failing }));
      const fiber = yield* read({
        instances: [primary(true)],
        http: server(() => Effect.never),
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      assert.isNull(yield* Fiber.join(fiber));
    }),
  );
});

describe("confirmQuitStopsRunningWork", () => {
  it.effect("uses the count the app reported unless Quit must read it", () =>
    Effect.gen(function* () {
      // A ready WSL backend makes the count read at Quit unknown, which would ask.
      yield* installRunningWorkReader.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(DesktopBackendPool.DesktopBackendPool, {
              list: Effect.succeed([primary(true), instance("wsl:Ubuntu", true)]),
            }),
            Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth, {
              getBearerToken: Effect.succeed("token"),
            }),
            server((request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ count: 0 }))),
            ),
          ),
        ),
      );
      dialog.asked = 0;
      assert.equal(yield* Effect.promise(() => confirmQuitStopsRunningWork("reported")), "none");
      assert.equal(dialog.asked, 0);
      assert.equal(yield* Effect.promise(() => confirmQuitStopsRunningWork("read")), "cancelled");
      assert.equal(dialog.asked, 1);
      yield* setRunningWork.handler(2, {} as Electron.IpcMainInvokeEvent);
      assert.equal(
        yield* Effect.promise(() => confirmQuitStopsRunningWork("reported")),
        "cancelled",
      );
      yield* setRunningWork.handler(0, {} as Electron.IpcMainInvokeEvent);
    }),
  );
});
describe("quitPrompt", () => {
  it("asks when work is running or unknown, and not when none is", () => {
    assert.isNull(quitPrompt(0));
    assert.isNotNull(quitPrompt(1));
    assert.isNotNull(quitPrompt(null));
  });
});
