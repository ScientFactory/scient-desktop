import { EnvironmentId, SCIENT_WORD_CONVERSION_TIMEOUT_MS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { exportEnvironmentWordFile, WORD_EXPORT_TIMEOUT_MS } from "./scientWordExportHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test/base",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

describe("exportEnvironmentWordFile", () => {
  it.effect("waits past the server's conversion limit, so the server reports the timeout", () =>
    Effect.gen(function* () {
      const requested = Promise.withResolvers<void>();
      // The server has not answered yet; the request only ends by timing out.
      const fetchFn = (() => {
        requested.resolve();
        return new Promise<Response>(() => {});
      }) satisfies typeof fetch;
      const pending = yield* exportEnvironmentWordFile({
        prepared: PREPARED,
        request: { cwd: "/work/project", relativePath: "notes.md", revision: "r1" },
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)), Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => requested.promise);

      yield* TestClock.adjust(SCIENT_WORD_CONVERSION_TIMEOUT_MS + 60_000);
      expect(pending.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust(WORD_EXPORT_TIMEOUT_MS - SCIENT_WORD_CONVERSION_TIMEOUT_MS - 60_000);
      expect(yield* Fiber.join(pending)).toMatchObject({ timeoutMs: WORD_EXPORT_TIMEOUT_MS });
    }),
  );
});
