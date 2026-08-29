import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  makeDroidConnectionActionsFromOpen,
  supportsDroidAcpLogout,
  type DroidAccountAcpSession,
  withDroidSessionShutdown,
} from "./DroidConnectionActions.ts";

const initializeResponse = (input?: {
  readonly devicePairing?: boolean;
  readonly logout?: boolean;
}): EffectAcpSchema.InitializeResponse => ({
  protocolVersion: 1,
  agentCapabilities: input?.logout ? { auth: { logout: {} } } : {},
  authMethods: input?.devicePairing
    ? [{ id: "device-pairing", name: "Factory device pairing" }]
    : [],
});

function actionsFor(session: DroidAccountAcpSession) {
  return makeDroidConnectionActionsFromOpen({
    open: Effect.succeed(session),
  });
}

describe("DroidConnectionActions", () => {
  it.effect("starts advertised ACP device pairing without inventing a browser URL or code", () =>
    Effect.gen(function* () {
      const authStarted = yield* Deferred.make<void>();
      const authCompleted = yield* Deferred.make<void>();
      const actions = actionsFor({
        initializeResult: initializeResponse({ devicePairing: true }),
        authenticate: Deferred.succeed(authStarted, undefined).pipe(
          Effect.andThen(Deferred.await(authCompleted)),
        ),
        logout: Effect.void,
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const attempt = yield* actions.start("droid_device_pairing");
          assert.strictEqual(attempt.authorizationUrl, undefined);
          assert.strictEqual(attempt.authorizationUrlKind, undefined);
          assert.strictEqual(attempt.userCode, undefined);
          assert.strictEqual(attempt.submitAuthorizationCode, undefined);
          assert.strictEqual(attempt.initialStatus, "waiting_for_browser");
          yield* Deferred.await(authStarted);
          yield* Deferred.succeed(authCompleted, undefined);
          yield* attempt.waitForCompletion;
        }),
      );
    }),
  );

  it.effect("interrupts the scoped ACP authentication fiber when the attempt is cancelled", () =>
    Effect.gen(function* () {
      const authStarted = yield* Deferred.make<void>();
      const authInterrupted = yield* Deferred.make<void>();
      const actions = actionsFor({
        initializeResult: initializeResponse({ devicePairing: true }),
        authenticate: Deferred.succeed(authStarted, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Deferred.succeed(authInterrupted, undefined).pipe(Effect.asVoid),
          ),
        ),
        logout: Effect.void,
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const attempt = yield* actions.start("droid_device_pairing");
          yield* Deferred.await(authStarted);
          yield* attempt.cancel;
          yield* Deferred.await(authInterrupted);
        }),
      );
    }),
  );

  it.effect("refuses device pairing when the exact initialized binary does not advertise it", () =>
    Effect.gen(function* () {
      const actions = actionsFor({
        initializeResult: initializeResponse(),
        authenticate: Effect.die(new Error("must not authenticate")),
        logout: Effect.void,
      });

      const failure = yield* Effect.scoped(actions.start("droid_device_pairing")).pipe(Effect.flip);
      assert.match(failure.message, /does not advertise Factory device pairing/u);
    }),
  );

  it.effect("executes logout only when the exact ACP peer advertises it", () =>
    Effect.gen(function* () {
      const logoutCalls = yield* Ref.make(0);
      const session = (logout: boolean): DroidAccountAcpSession => ({
        initializeResult: initializeResponse({ devicePairing: true, logout }),
        authenticate: Effect.void,
        logout: Ref.update(logoutCalls, (count) => count + 1),
      });

      const peerBlocked = actionsFor(session(false));
      const peerFailure = yield* Effect.scoped(peerBlocked.disconnect).pipe(Effect.flip);
      assert.match(peerFailure.message, /no longer advertises assisted sign out/u);

      yield* Effect.scoped(actionsFor(session(true)).disconnect);
      assert.strictEqual(yield* Ref.get(logoutCalls), 1);
    }),
  );

  it.effect("stops active sessions before logout and preserves the shutdown failure", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (event: string) => Ref.update(events, (current) => [...current, event]);
      const session: DroidAccountAcpSession = {
        initializeResult: initializeResponse({ devicePairing: true, logout: true }),
        authenticate: Effect.void,
        logout: record("logout"),
      };

      yield* Effect.scoped(
        withDroidSessionShutdown(actionsFor(session), record("stop-sessions")).disconnect,
      );
      assert.deepStrictEqual(yield* Ref.get(events), ["stop-sessions", "logout"]);

      const stopFailure = new Error("session remained active");
      const failure = yield* Effect.scoped(
        withDroidSessionShutdown(actionsFor(session), Effect.fail(stopFailure)).disconnect,
      ).pipe(Effect.flip);
      assert.strictEqual(
        failure.message,
        "Scient could not stop active Droid sessions before sign out.",
      );
      assert.strictEqual(failure.cause, stopFailure);
      assert.deepStrictEqual(yield* Ref.get(events), ["stop-sessions", "logout"]);
    }),
  );

  it("recognizes only a concrete ACP logout capability", () => {
    assert.strictEqual(supportsDroidAcpLogout(initializeResponse({ logout: true })), true);
    assert.strictEqual(supportsDroidAcpLogout(initializeResponse()), false);
    assert.strictEqual(
      supportsDroidAcpLogout({
        ...initializeResponse(),
        agentCapabilities: { auth: { logout: null } },
      }),
      false,
    );
  });
});
