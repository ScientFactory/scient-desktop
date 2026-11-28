/**
 * The clients' activity leases, and the host's power state they are judged with, shared by the
 * background policy, which records them, and the Accounts vault, which Server Settings builds
 * before the policy and which reads them as it opens. Nothing here imports either, so each loads
 * on its own, in any order.
 */
import type { ClientActivityLease, ClientKind, HostPowerSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export class ClientActivityLeases extends Context.Service<
  ClientActivityLeases,
  {
    readonly leases: Ref.Ref<Map<string, ClientActivityLease>>;
    /** Reads the host's power and lock state, once the policy that watches it is built. */
    readonly hostPower: Ref.Ref<Effect.Effect<HostPowerSnapshot> | undefined>;
  }
>()("t3/scient/accounts/clientLeases/ClientActivityLeases") {}

export const leasesLayer = Layer.effect(
  ClientActivityLeases,
  Effect.all({
    leases: Ref.make(new Map<string, ClientActivityLease>()),
    hostPower: Ref.make<Effect.Effect<HostPowerSnapshot> | undefined>(undefined),
  }),
);

/**
 * The kind a client reports, as far as its session vouches for it: only this computer's desktop,
 * signed in with the desktop's own sign-in, is the desktop renderer. The kind is the client's
 * word; the session's subject is the server's.
 */
export const vouchedClientKind = (subject: string, kind: ClientKind): ClientKind =>
  kind === "desktop-renderer" && subject !== "desktop-bootstrap" ? "unknown" : kind;

/**
 * Someone at this computer can answer a dialog now: this computer's desktop app shows a window
 * with focus (not one merely used lately; never a web client or a phone, which may be elsewhere),
 * and the computer isn't locked. Stricter than what lets background work run.
 */
export const someoneAtWindow = Effect.fn("ClientActivityLeases.someoneAtWindow")(function* (
  shared: ClientActivityLeases["Service"],
) {
  const hostPower = yield* Ref.get(shared.hostPower);
  if (hostPower !== undefined && (yield* hostPower).locked === "true") return false;
  const now = yield* DateTime.now;
  return [...(yield* Ref.get(shared.leases)).values()].some(
    (lease) =>
      DateTime.isGreaterThan(lease.expiresAt, now) &&
      lease.visible &&
      lease.focused &&
      lease.clientKind === "desktop-renderer",
  );
});
