import type { ProviderAuthState, ProviderSetupError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ProviderAuthController } from "../../provider/ProviderAuthService.ts";
import type { ProviderConnectionActions } from "../../provider/ProviderDriver.ts";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";

const failure = (message: string) => new ProviderConnectionActionError({ message });
const mapSetupError = (cause: ProviderSetupError) =>
  new ProviderConnectionActionError({ message: cause.detail, cause });
const terminal = (state: ProviderAuthState) =>
  state.phase === "succeeded" || state.phase === "failed" || state.phase === "cancelled";

/** Scient's lifecycle surface uses the instance's SDK auth and credential ownership. */
export const makeCursorSdkConnectionActions = Effect.fn("makeCursorSdkConnectionActions")(
  function* (controller: ProviderAuthController) {
    const crypto = yield* Crypto.Crypto;
    return {
      methods: ["cursor_browser"],
      start: Effect.fnUntraced(function* (method) {
        if (method !== "cursor_browser")
          return yield* failure("Cursor does not support this sign-in method.");
        const owner = `scient-cursor-${yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderConnectionActionError({
                message: "Could not start Cursor sign-in. Try again.",
                cause,
              }),
          ),
        )}`;
        const started = yield* Effect.acquireRelease(
          controller.start(owner).pipe(Effect.mapError(mapSetupError)),
          (state) =>
            state.flowId ? controller.cancel(owner, state.flowId).pipe(Effect.ignore) : Effect.void,
        );
        const flowId = started.flowId;
        if (!flowId) return yield* failure("Cursor did not start a sign-in flow.");

        const readState = (ready: (state: ProviderAuthState) => boolean) =>
          controller.subscribe(owner).pipe(
            Stream.mapEffect((state) =>
              state.flowId === flowId
                ? Effect.succeed(state)
                : Effect.fail(failure("This Cursor sign-in flow is no longer active.")),
            ),
            Stream.filter(ready),
            Stream.runHead,
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(failure("The Cursor sign-in flow stopped.")),
                onSome: Effect.succeed,
              }),
            ),
          );
        const ensureSuccess = (state: ProviderAuthState) =>
          state.phase === "succeeded"
            ? Effect.void
            : Effect.fail(failure(state.message ?? "Cursor sign-in did not finish."));
        const first = yield* readState(
          (state) =>
            (state.phase === "waiting" && state.authorizationUrl !== null) ||
            state.phase === "verifying" ||
            terminal(state),
        ).pipe(
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () => Effect.fail(failure("Cursor did not provide a sign-in page. Try again.")),
          }),
        );
        if (terminal(first)) yield* ensureSuccess(first);
        return {
          initialStatus: first.authorizationUrl ? "waiting_for_browser" : "verifying",
          ...(first.authorizationUrl
            ? {
                authorizationUrl: first.authorizationUrl,
                authorizationUrlKind: "primary" as const,
              }
            : {}),
          waitForCompletion: readState(terminal).pipe(Effect.flatMap(ensureSuccess)),
          cancel: controller
            .cancel(owner, flowId)
            .pipe(Effect.asVoid, Effect.mapError(mapSetupError)),
        };
      }),
      disconnect: controller
        .logout(Effect.void)
        .pipe(Effect.asVoid, Effect.mapError(mapSetupError)),
    } satisfies ProviderConnectionActions;
  },
);
