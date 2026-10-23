import { assert, describe, it } from "@effect/vitest";
import { ConnectorId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import * as ConnectorSessionDelivery from "./ConnectorSessionDelivery.ts";
import * as ExtensionDeliveryReceipts from "./ExtensionDeliveryReceipts.ts";
import {
  ConnectorRuntime,
  type EligibleConnector,
  ExtensionDeliveryReceipts as ExtensionDeliveryReceiptsTag,
} from "./ExtensionsServices.ts";

const connector = (name: string): EligibleConnector => ({
  connectorId: ConnectorId.make(`con_${name}00000000`),
  serverName: name,
  displayName: name.toUpperCase(),
});
const linear = connector("linear");
const notion = connector("notion");
const github = connector("github");

describe("planConnectorDelivery", () => {
  it("delivers eligible connectors except native name collisions, keeping runtime skips", () => {
    const plan = ConnectorSessionDelivery.planConnectorDelivery({
      resolution: {
        eligible: [linear, github, notion],
        skipped: [{ ...connector("hf"), reason: "disabled" }],
      },
      support: { status: "supported" },
      nativeServerNames: new Set(["github"]),
    });
    assert.deepEqual(plan.delivered, [linear, notion]);
    assert.deepEqual(plan.skipped, [
      { ...connector("hf"), reason: "disabled" },
      { ...github, reason: "name-collision" },
    ]);
  });

  it("treats an unreported native inventory as no collision", () => {
    const plan = ConnectorSessionDelivery.planConnectorDelivery({
      resolution: { eligible: [github], skipped: [] },
      support: { status: "conditional", reason: "Depends on the agent." },
      nativeServerNames: undefined,
    });
    assert.deepEqual(plan, { delivered: [github], skipped: [] });
  });

  it("skips every eligible connector for a driver without connector transport", () => {
    const plan = ConnectorSessionDelivery.planConnectorDelivery({
      resolution: { eligible: [linear, notion], skipped: [{ ...github, reason: "needs-auth" }] },
      support: { status: "unsupported", reason: "No transport." },
      nativeServerNames: new Set(["linear"]),
    });
    assert.deepEqual(plan.delivered, []);
    assert.deepEqual(plan.skipped, [
      { ...github, reason: "needs-auth" },
      { ...linear, reason: "transport-unsupported" },
      { ...notion, reason: "transport-unsupported" },
    ]);
  });
});

describe("sameDeliveredConnectors", () => {
  const issued = [linear, notion].map((entry) => ({
    ...entry,
    url: `http://x/${entry.connectorId}`,
  }));
  const scope = new Set([linear.connectorId, notion.connectorId]);

  it("accepts only the identical ordered set bound into the credential", () => {
    assert.isTrue(
      ConnectorSessionDelivery.sameDeliveredConnectors(issued, scope, [linear, notion]),
    );
    assert.isTrue(ConnectorSessionDelivery.sameDeliveredConnectors([], undefined, []));
    assert.isFalse(
      ConnectorSessionDelivery.sameDeliveredConnectors(issued, scope, [notion, linear]),
    );
    assert.isFalse(ConnectorSessionDelivery.sameDeliveredConnectors(issued, scope, [linear]));
    assert.isFalse(
      ConnectorSessionDelivery.sameDeliveredConnectors(issued, scope, [
        linear,
        { ...notion, serverName: "notion_2" },
      ]),
    );
    // The provider-facing copy and the authorization scope must agree.
    assert.isFalse(
      ConnectorSessionDelivery.sameDeliveredConnectors(issued, new Set([linear.connectorId]), [
        linear,
        notion,
      ]),
    );
    assert.isFalse(
      ConnectorSessionDelivery.sameDeliveredConnectors(issued, undefined, [linear, notion]),
    );
  });
});

describe("ConnectorSessionDelivery.make", () => {
  const plan = (driver: string, mcpInjection = true) =>
    Effect.gen(function* () {
      const delivery = yield* ConnectorSessionDelivery.make;
      return yield* delivery.plan({
        driver: ProviderDriverKind.make(driver),
        mcpInjection,
        projectId: Effect.undefined,
        provider: Effect.die("provider snapshot must not be read"),
      });
    });

  it.effect("delivers nothing and reads nothing without a connector runtime", () =>
    Effect.gen(function* () {
      const result = yield* ConnectorSessionDelivery.make.pipe(
        Effect.flatMap((delivery) =>
          delivery.plan({
            driver: ProviderDriverKind.make("codex"),
            mcpInjection: true,
            projectId: Effect.die("project must not be read"),
            provider: Effect.die("provider snapshot must not be read"),
          }),
        ),
      );
      assert.deepEqual(result, { delivered: [], skipped: [] });
    }),
  );

  it.effect("does not read the provider snapshot for an unsupported driver", () =>
    plan("unreviewed-driver").pipe(
      Effect.map((result) =>
        assert.deepEqual(result.skipped, [{ ...linear, reason: "transport-unsupported" }]),
      ),
      Effect.provide(
        Layer.mock(ConnectorRuntime)({
          resolveDelivery: () => Effect.succeed({ eligible: [linear], skipped: [] }),
        }),
      ),
    ),
  );

  it.effect("skips every connector for a session without an MCP channel, even on Codex", () =>
    plan("codex", false).pipe(
      Effect.map((result) =>
        assert.deepEqual(result, {
          delivered: [],
          skipped: [{ ...linear, reason: "transport-unsupported" }],
        }),
      ),
      Effect.provide(
        Layer.mock(ConnectorRuntime)({
          resolveDelivery: () => Effect.succeed({ eligible: [linear], skipped: [] }),
        }),
      ),
    ),
  );

  it.effect("records a receipt in the contract shape", () =>
    Effect.gen(function* () {
      const delivery = yield* ConnectorSessionDelivery.make;
      const threadId = ThreadId.make("thread-receipt");
      yield* delivery.record({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: "credential-1",
        issuedAtMillis: Date.UTC(2026, 9, 21),
        plan: { delivered: [linear], skipped: [{ ...github, reason: "name-collision" }] },
      });
      const receipts = yield* ExtensionDeliveryReceiptsTag;
      assert.deepEqual(Option.getOrUndefined(yield* receipts.get(threadId)), {
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: "credential-1",
        issuedAt: "2026-10-21T00:00:00.000Z",
        delivered: [{ kind: "connector", ...linear }],
        skipped: [{ entry: { kind: "connector", ...github }, reason: "name-collision" }],
      });
    }).pipe(Effect.provide(ExtensionDeliveryReceipts.layer)),
  );

  it.effect.each(["A", "B"] as const)(
    "amends only the issuing runtime's receipts while two runtimes overlap (%s closes first)",
    (closedFirst) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-two-runtimes");
        const runtime = Effect.fnUntraced(function* (credential: string) {
          const scope = yield* Scope.make();
          const context = yield* Layer.buildWithScope(ExtensionDeliveryReceipts.layer, scope);
          const receipts = yield* ExtensionDeliveryReceiptsTag.pipe(Effect.provideContext(context));
          const delivery = yield* ConnectorSessionDelivery.make.pipe(
            Effect.provideContext(context),
          );
          yield* delivery.record({
            threadId,
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            providerSessionId: credential,
            issuedAtMillis: 0,
            plan: { delivered: [linear], skipped: [] },
          });
          const delivered = Effect.map(receipts.get(threadId), (receipt) =>
            Option.getOrUndefined(receipt)?.delivered.map((entry) => entry.serverName),
          );
          const begin = delivery.registrationTrackerFor({
            threadId,
            providerSessionId: credential,
          });
          return {
            scope,
            delivered,
            report: (outcome: Parameters<Effect.Success<typeof begin>>[0]) =>
              Effect.flatMap(begin, (reporter) => reporter(outcome)),
          };
        });
        const a = yield* runtime("credential-A");
        const b = yield* runtime("credential-B");

        const [closed, live] = closedFirst === "A" ? [a, b] : [b, a];
        // Both alive: each credential's callback reaches only its own store.
        yield* closed.report({ withheld: [{ serverName: "linear", reason: "name-collision" }] });
        assert.deepEqual(yield* closed.delivered, []);
        assert.deepEqual(yield* live.delivered, ["linear"]);

        // The other runtime is gone; this one still amends its own store.
        yield* Scope.close(closed.scope, Exit.void);
        yield* live.report({
          withheld: [{ serverName: "linear", reason: "native-servers-unknown" }],
        });
        assert.deepEqual(yield* live.delivered, []);
        yield* Scope.close(live.scope, Exit.void);
      }),
  );
});

describe("ConnectorSessionDelivery credential tracker", () => {
  const threadId = ThreadId.make("thread-tracker");
  const collision = { withheld: [{ serverName: "linear", reason: "name-collision" as const }] };
  const allRegistered = { withheld: [] };

  const setup = Effect.gen(function* () {
    const receipts = yield* ExtensionDeliveryReceipts.make;
    const delivery = yield* ConnectorSessionDelivery.make.pipe(
      Effect.provideService(ExtensionDeliveryReceiptsTag, receipts),
    );
    // Created once, as the manager does when it issues the credential.
    const begin = delivery.registrationTrackerFor({ threadId, providerSessionId: "credential-C" });
    const record = (registration?: typeof begin) =>
      delivery.record({
        threadId,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        providerSessionId: "credential-C",
        issuedAtMillis: 0,
        plan: { delivered: [linear], skipped: [] },
        registration,
      });
    yield* record();
    return {
      receipts,
      // What the manager does when it reuses the live credential.
      recordCredential: record(begin),
      begin,
      delivered: Effect.map(receipts.get(threadId), (receipt) =>
        Option.getOrUndefined(receipt)?.delivered.map((entry) => entry.serverName),
      ),
    };
  });

  it.effect("keeps the registration that started last, whichever reports last", () =>
    Effect.gen(function* () {
      const { begin, delivered } = yield* setup;
      const older = yield* begin;
      const newer = yield* begin;
      yield* newer(collision);
      yield* older(allRegistered);
      assert.deepEqual(yield* delivered, []);
    }),
  );

  it.effect.each(["newer reports first", "older reports first"] as const)(
    "orders late reports after the receipt was evicted and re-recorded (%s)",
    (order) =>
      Effect.gen(function* () {
        const { receipts, recordCredential, begin, delivered } = yield* setup;
        // The older query starts before the thread's receipt is evicted.
        const older = yield* begin;
        for (let index = 0; index < ExtensionDeliveryReceipts.MAX_RETAINED_RECEIPTS; index += 1) {
          yield* receipts.record({
            threadId: ThreadId.make(`thread-filler-${index}`),
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            providerSessionId: `filler-${index}`,
            issuedAt: "2026-10-21T00:00:00.000Z",
            delivered: [],
            skipped: [],
          });
        }
        assert.isUndefined(yield* delivered);
        // The same live credential is prepared again and a newer query starts.
        yield* recordCredential;
        const newer = yield* begin;

        if (order === "newer reports first") {
          yield* newer(allRegistered);
          yield* older(collision);
          assert.deepEqual(yield* delivered, ["linear"]);
        } else {
          yield* older(allRegistered);
          yield* newer(collision);
          assert.deepEqual(yield* delivered, []);
        }
      }),
  );

  it.effect("re-applies the latest outcome when the evicted receipt is recorded again", () =>
    Effect.gen(function* () {
      const { receipts, recordCredential, begin, delivered } = yield* setup;
      yield* (yield* begin)(collision);
      for (let index = 0; index < ExtensionDeliveryReceipts.MAX_RETAINED_RECEIPTS; index += 1) {
        yield* receipts.record({
          threadId: ThreadId.make(`thread-filler-${index}`),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          providerSessionId: `filler-${index}`,
          issuedAt: "2026-10-21T00:00:00.000Z",
          delivered: [],
          skipped: [],
        });
      }
      assert.isUndefined(yield* delivered);

      yield* recordCredential;
      assert.deepEqual(yield* delivered, []);
      yield* (yield* begin)(allRegistered);
      assert.deepEqual(yield* delivered, ["linear"]);
    }),
  );
});
