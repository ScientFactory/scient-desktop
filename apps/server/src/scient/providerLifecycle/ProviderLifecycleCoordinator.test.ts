import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { make } from "./ProviderLifecycleCoordinator.ts";

const CODEX = ProviderDriverKind.make("codex");
const PRIMARY = ProviderInstanceId.make("codex");
const SECONDARY = ProviderInstanceId.make("codex-work");

describe("ProviderLifecycleCoordinator", () => {
  it.effect("keeps shared runtime changes exclusive across provider accounts", () =>
    Effect.gen(function* () {
      const coordinator = yield* make;

      assert.strictEqual(
        yield* coordinator.reserve({
          instanceId: PRIMARY,
          provider: CODEX,
          reservation: { operationId: "runtime-1", kind: "runtime" },
        }),
        true,
      );
      assert.strictEqual(
        yield* coordinator.reserve({
          instanceId: SECONDARY,
          provider: CODEX,
          reservation: { operationId: "connection-1", kind: "connection" },
        }),
        false,
      );
      assert.strictEqual(yield* coordinator.release({ operationId: "runtime-1" }), true);
      assert.strictEqual(
        yield* coordinator.reserve({
          instanceId: SECONDARY,
          provider: CODEX,
          reservation: { operationId: "connection-1", kind: "connection" },
        }),
        true,
      );
    }),
  );

  it.effect("allows independent sign-ins but blocks shared maintenance until they finish", () =>
    Effect.gen(function* () {
      const coordinator = yield* make;

      assert.strictEqual(
        yield* coordinator.reserve({
          instanceId: PRIMARY,
          provider: CODEX,
          reservation: { operationId: "connection-1", kind: "connection" },
        }),
        true,
      );
      assert.strictEqual(
        yield* coordinator.reserve({
          instanceId: SECONDARY,
          provider: CODEX,
          reservation: { operationId: "connection-2", kind: "connection" },
        }),
        true,
      );
      assert.strictEqual(
        yield* coordinator.reserve({
          instanceId: SECONDARY,
          provider: CODEX,
          reservation: { operationId: "maintenance-1", kind: "maintenance" },
        }),
        false,
      );
      assert.strictEqual(yield* coordinator.release({ operationId: "connection-1" }), true);
      assert.strictEqual(yield* coordinator.release({ operationId: "connection-2" }), true);
      assert.strictEqual(
        yield* coordinator.reserve({
          instanceId: SECONDARY,
          provider: CODEX,
          reservation: { operationId: "maintenance-1", kind: "maintenance" },
        }),
        true,
      );
    }),
  );
});
