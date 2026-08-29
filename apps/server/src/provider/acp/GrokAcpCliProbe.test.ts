/**
 * Optional integration checks against a real `grok agent stdio` install.
 * Safe initialize-only probe (fresh isolated HOME, no credentials required):
 * T3_GROK_ACP_SAFE_PROBE=1 T3_GROK_ACP_SAFE_HOME=/tmp/grok-probe bun run test GrokAcpCliProbe
 *
 * Full authenticated session probe (may open the system browser):
 * Enable with: T3_GROK_ACP_PROBE=I_ACCEPT_BROWSER_SIDE_EFFECTS bun run test GrokAcpCliProbe
 *
 * The probe assumes either `XAI_API_KEY` is set in the environment or
 * the user has previously run `grok login`. Without credentials the
 * agent's `authenticate` request will fail and the test will surface
 * the error.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { GrokSettings } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { checkGrokProviderStatus } from "../Layers/GrokProvider.ts";
import { makeGrokConnectionActions } from "../../scient/providerLifecycle/GrokConnectionActions.ts";
import { GROK_AUTH_EXTENSION_METHOD, makeGrokAcpRuntime } from "./GrokAcpSupport.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

function safeProbeEnvironment(): NodeJS.ProcessEnv {
  const isolatedHome = process.env.T3_GROK_ACP_SAFE_HOME?.trim();
  if (!isolatedHome) {
    throw new Error("T3_GROK_ACP_SAFE_HOME is required for the safe real-CLI probe.");
  }
  return {
    ...process.env,
    HOME: isolatedHome,
    XAI_API_KEY: undefined,
  };
}

const makeProbeRuntime = (environment: NodeJS.ProcessEnv = process.env) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* makeGrokAcpRuntime({
      grokSettings: { binaryPath: "grok" },
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-grok-probe", version: "0.0.0" },
    });
  });

describe.runIf(process.env.T3_GROK_ACP_SAFE_PROBE === "1")("Grok ACP CLI safe probe", () => {
  it.effect("initializes without authenticating or creating a session", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime(safeProbeEnvironment());
      const initialized = yield* runtime.initialize();
      const authInfo = yield* runtime.request(GROK_AUTH_EXTENSION_METHOD.info, {});

      expect(initialized.protocolVersion).toBe(1);
      expect(initialized.authMethods?.map((method) => method.id)).toContain("grok.com");
      expect(authInfo).toMatchObject({ methodId: null });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a fresh isolated installation as ready for subscription sign in", () =>
    Effect.gen(function* () {
      const provider = yield* checkGrokProviderStatus(
        decodeGrokSettings({ enabled: true, binaryPath: "grok" }),
        safeProbeEnvironment(),
      );

      expect(provider.installed).toBe(true);
      expect(provider.version).toBe("1.0.5");
      expect(provider.status).toBe("warning");
      expect(provider.auth).toEqual({
        status: "unauthenticated",
        required: true,
        type: "grok_account",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

// This probe intentionally causes the official Grok process to open the system
// browser. Keep the explicit acknowledgement hard to enable accidentally and
// never include it in automated verification.
describe.runIf(process.env.T3_GROK_ACP_DEVICE_PROBE === "I_ACCEPT_BROWSER_SIDE_EFFECTS")(
  "Grok ACP CLI device-flow probe",
  () => {
    it.effect("starts the official device flow and handles URL or immediate completion", () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const actions = yield* makeGrokConnectionActions(
          decodeGrokSettings({ enabled: true, binaryPath: "grok" }),
          safeProbeEnvironment(),
          childProcessSpawner,
        );
        const attempt = yield* actions.start("grok_device_code");
        if (attempt.authorizationUrl) {
          yield* Effect.sync(() => {
            expect(attempt.authorizationUrl).toMatch(/^https:\/\//);
            expect(attempt.userCode).toBeTruthy();
            expect(attempt.submitAuthorizationCode).toBeUndefined();
          }).pipe(Effect.ensuring(attempt.cancel.pipe(Effect.ignore)));
        } else {
          yield* attempt.waitForCompletion;
          yield* actions.disconnect;
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  },
);

const makeAuthenticatedProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeGrokAcpRuntime({
    grokSettings: { binaryPath: "grok" },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-grok-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_GROK_ACP_PROBE === "I_ACCEPT_BROWSER_SIDE_EFFECTS")(
  "Grok ACP CLI probe",
  () => {
    it.effect("initialize and authenticate against real grok agent stdio", () =>
      Effect.gen(function* () {
        const runtime = yield* makeAuthenticatedProbeRuntime;
        const started = yield* runtime.start();
        expect(started.initializeResult).toBeDefined();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect("session/new advertises typed SessionModelState with at least one model", () =>
      Effect.gen(function* () {
        const runtime = yield* makeAuthenticatedProbeRuntime;
        const started = yield* runtime.start();
        const result = started.sessionSetupResult;

        expect(typeof started.sessionId).toBe("string");

        // Modern grok-shell advertises models through the typed
        // `SessionModelState` field, not via a `configOptions` entry.
        // If this assertion fails the upstream surface has regressed.
        const models = result.models;
        expect(models).toBeDefined();
        expect(typeof models?.currentModelId).toBe("string");
        expect(models?.availableModels.length ?? 0).toBeGreaterThan(0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect("session/set_model accepts a no-op switch to the current model", () =>
      Effect.gen(function* () {
        const runtime = yield* makeAuthenticatedProbeRuntime;
        const started = yield* runtime.start();
        const currentModelId = started.sessionSetupResult.models?.currentModelId?.trim();
        expect(currentModelId).toBeDefined();
        if (!currentModelId) return;

        // No-op switch — selecting the model the session already runs on must
        // succeed against every Grok build that implements `session/set_model`.
        yield* runtime.setSessionModel(currentModelId);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect("session/set_model accepts advertised reasoning effort metadata", () =>
      Effect.gen(function* () {
        const runtime = yield* makeAuthenticatedProbeRuntime;
        const started = yield* runtime.start();
        const modelState = started.sessionSetupResult.models;
        const currentModelId = modelState?.currentModelId.trim();
        expect(currentModelId).toBeDefined();
        if (!currentModelId) return;

        const currentModel = modelState?.availableModels.find(
          (model) => model.modelId.trim() === currentModelId,
        );
        const reasoningEffort = currentModel?._meta?.reasoningEffort;
        expect(typeof reasoningEffort).toBe("string");
        if (typeof reasoningEffort !== "string") return;

        yield* runtime.setSessionModel(currentModelId, { reasoningEffort });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect.skipIf(process.env.T3_GROK_LIVE_TURN !== "1")(
      "finishes a real Grok turn and streams its answer",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const cwd = yield* fileSystem.makeTempDirectoryScoped();
          const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const runtime = yield* makeGrokAcpRuntime({
            grokSettings: { binaryPath: "grok" },
            environment: process.env,
            childProcessSpawner,
            cwd,
            runtimeMode: "approval-required",
            clientInfo: { name: "t3-grok-probe", version: "0.0.0" },
          });
          yield* runtime.start();
          const chunks: string[] = [];
          const events = yield* Stream.runForEach(runtime.getEvents(), (event) => {
            if (event._tag === "EventStreamBarrier") {
              return Deferred.succeed(event.acknowledge, undefined);
            }
            if (event._tag === "ContentDelta") {
              chunks.push(event.text);
            }
            return Effect.void;
          }).pipe(Effect.forkChild);
          const result = yield* runtime.prompt({
            prompt: [{ type: "text", text: "Reply exactly GROK_T3_OK. Do not use any tools." }],
          });
          yield* runtime.drainEvents;
          expect(result.stopReason).toBe("end_turn");
          expect(chunks.join("")).toContain("GROK_T3_OK");
          yield* Fiber.interrupt(events);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  },
);
