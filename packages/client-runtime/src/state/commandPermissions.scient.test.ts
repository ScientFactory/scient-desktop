import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { createScientSourcesCommands } from "./scientSourcesCommands.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);

const env = EnvironmentId.make("library");
const target = new PrimaryConnectionTarget({
  environmentId: env,
  label: "Library",
  httpBaseUrl: "https://library.example.test",
  wsBaseUrl: "wss://library.example.test",
});
const prepared: PreparedConnection = {
  environmentId: env,
  label: target.label,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: "wss://library.example.test/ws",
  httpAuthorization: null,
  target,
};
const session = (scopes: Array<AuthEnvironmentScope>): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes,
  permissions: scopes,
});
const readOnly = session([AuthOrchestrationReadScope]);
const operate = session([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
const removal = {
  target: {
    environmentId: env,
    input: { root: "/project", sourceId: "src_1", expectedRevision: 1 },
  },
} as const;

const setup = Effect.gen(function* () {
  const fetchFn = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          outcome: "removed",
          sourceId: "src_1",
          revision: 2,
          removedAttachmentCount: 0,
          retainedAttachmentCount: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  const supervisor = {
    target,
    prepared: yield* SubscriptionRef.make(Option.some(prepared)),
  } as unknown as EnvironmentSupervisor["Service"];
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry, {
        run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) =>
          Effect.provideService(effect, EnvironmentSupervisor, supervisor),
      } as unknown as EnvironmentRegistry["Service"]),
      layerRemoteHttpClient(fetchFn),
    ),
  );
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return { commands: createScientSourcesCommands(runtime), fetchFn, registry };
});

const expectRefused = (result: {
  readonly _tag: string;
  readonly cause?: Cause.Cause<unknown>;
}) => {
  expect(result._tag).toBe("Failure");
  expect(result.cause && Cause.squash(result.cause)).toMatchObject({
    _tag: "EnvironmentAuthorizationError",
    requiredPermission: AuthOrchestrationOperateScope,
  });
};

describe("Sources command permissions", () => {
  it.effect("keeps a read-only destination from sending any Library change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands, fetchFn, registry } = yield* setup;
        registry.set(sessions(env), AsyncResult.success(readOnly));
        for (const command of Object.values(commands))
          expect(registry.get(command.permissionAtom(env))).toBe(false);
        expectRefused(yield* Effect.promise(() => commands.remove.run(registry, removal.target)));
        expect(fetchFn).not.toHaveBeenCalled();

        registry.set(sessions(env), AsyncResult.success(operate));
        for (const command of Object.values(commands))
          expect(registry.get(command.permissionAtom(env))).toBe(true);
        const sent = yield* Effect.promise(() => commands.remove.run(registry, removal.target));
        expect(sent._tag).toBe("Success");
        expect(fetchFn).toHaveBeenCalledOnce();
      }),
    ),
  );

  it.effect("refuses a change whose grant was revoked after its control was enabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands, fetchFn, registry } = yield* setup;
        registry.set(sessions(env), AsyncResult.success(operate));
        expect(registry.get(commands.remove.permissionAtom(env))).toBe(true);
        registry.set(sessions(env), AsyncResult.success(readOnly));
        expectRefused(yield* Effect.promise(() => commands.remove.run(registry, removal.target)));
        expect(fetchFn).not.toHaveBeenCalled();
      }),
    ),
  );
});
