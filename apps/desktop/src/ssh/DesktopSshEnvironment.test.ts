import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

it.effect("preserves prompt presentation diagnostics through the desktop service", () => {
  const cause = new DesktopSshPasswordPrompts.DesktopSshPromptPresentationError({
    requestId: "prompt-1",
    destination: "devbox",
    operation: "send-prompt-request",
    cause: new Error("renderer send failed"),
  });
  return Effect.gen(function* () {
    const service = yield* DesktopSshEnvironment.make;
    const error = yield* service
      .ensureEnvironment({
        alias: "devbox",
        hostname: "devbox.example",
        username: null,
        port: null,
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "SshPasswordPromptError");
    if (error._tag !== "SshPasswordPromptError") throw new Error("Unexpected SSH error");
    assert.equal(error.message, "Scient window is not available for SSH authentication.");
    assert.strictEqual(error.cause, cause);
    assert.equal(cause.message, "Failed to present SSH password prompt for devbox.");
    assert.equal(cause.operation, "send-prompt-request");
  }).pipe(
    Effect.provideService(SshTunnel.SshEnvironmentManager, {
      ensureEnvironment: () =>
        Effect.gen(function* () {
          const prompt = yield* SshAuth.SshPasswordPrompt;
          yield* prompt.request({
            destination: "devbox",
            username: null,
            prompt: "Password:",
            attempt: 1,
          });
          return yield* Effect.die("Unexpected successful password prompt");
        }),
      disconnectEnvironment: () => Effect.void,
    }),
    Effect.provideService(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
      request: () => Effect.fail(cause),
      resolve: () => Effect.void,
    }),
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici, NetService.layer),
    ),
    Effect.scoped,
  );
});
