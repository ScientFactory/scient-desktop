import { describe, expect, it } from "@effect/vitest";
import type { EnvironmentConnectReachability } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ConnectReachability from "../../cloud/ConnectReachability.ts";
import { requireReachableGuestHost } from "./guestLinkReachability.ts";

const reachable: EnvironmentConnectReachability = {
  status: "reachable",
  checkedAt: "2026-11-10T00:00:00.000Z",
  readyConnections: 4,
  protocol: "quic",
};
const unreachable: EnvironmentConnectReachability = {
  status: "unreachable",
  checkedAt: "2026-11-10T00:00:00.000Z",
  cause: "no_connector",
  reason: "Cloudflare has no live connection from this machine for the tunnel.",
  hint: null,
  fix: "Restart Scient.",
};

const withReachability = (
  latest: EnvironmentConnectReachability | null,
  checked: EnvironmentConnectReachability,
) => {
  const counter = { checks: 0 };
  const layer = Layer.succeed(ConnectReachability.ConnectReachability)({
    latest: Effect.succeed(Option.fromNullishOr(latest)),
    check: Effect.sync(() => {
      counter.checks += 1;
      return checked;
    }),
  });
  return { counter, layer };
};

describe("requireReachableGuestHost", () => {
  it.effect("trusts a reachable answer without checking again", () =>
    Effect.gen(function* () {
      const { counter, layer } = withReachability(reachable, unreachable);
      yield* requireReachableGuestHost().pipe(Effect.provide(layer));
      expect(counter.checks).toBe(0);
    }),
  );

  it.effect("checks again before refusing on an earlier unreachable answer", () =>
    Effect.gen(function* () {
      const { counter, layer } = withReachability(unreachable, reachable);
      yield* requireReachableGuestHost().pipe(Effect.provide(layer));
      expect(counter.checks).toBe(1);
    }),
  );

  it.effect("refuses a link while other devices cannot reach the server", () =>
    Effect.gen(function* () {
      const { layer } = withReachability(null, unreachable);
      const error = yield* requireReachableGuestHost().pipe(Effect.provide(layer), Effect.flip);
      expect(error.reason).toBe("connect_unavailable");
    }),
  );
});
