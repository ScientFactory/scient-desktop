import { expect, it } from "@effect/vitest";
import { ConnectorId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { libraryKeyFits } from "@t3tools/shared/scientLibraryKeys";

import { accountTokenRef } from "./AccountBoundRef.ts";
import { makeHarness, secretEquals, syntheticValue } from "./Accounts.testkit.ts";
import { typedDigest } from "./AccountsService.ts";

const connectorId = ConnectorId.make("con_synthetic01");
const origin = "https://mcp.example.com";
const scope = { threadId: ThreadId.make("thread-a"), projectId: undefined, unattended: false };

it.effect("a key kept for one connector reaches that connector only, as its typed key did", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    const value = syntheticValue();
    const accountId = yield* service.keepPrivateKey!({
      use: { kind: "connector", id: connectorId, name: "Example MCP" },
      sites: [origin],
      auth: { type: "bearer" },
      value: Redacted.make(value),
    });
    const ref = accountTokenRef(accountId);
    // Saved Off, yet its own connector still gets it, with the agent switch off too.
    yield* service.setAgentAccess(false);
    const own = {
      kind: "connector" as const,
      connectorId,
      origin,
      auth: { type: "bearer" as const },
    };
    expect(secretEquals(yield* service.resolveBound(ref, own), value)).toBe(true);
    yield* service.setAgentAccess(true);
    const other = { ...own, connectorId: ConnectorId.make("con_synthetic02") };
    expect((yield* Effect.flip(service.resolveBound(ref, other))).reason).toBe("denied");
    expect((yield* service.forSession(scope)).accounts).toEqual([]);
    expect(yield* service.listBindable({ origin })).toEqual([]);
    const asked = yield* Effect.flip(
      service.authorize(scope, { type: "account", accountId }, "request"),
    );
    expect(asked.reason).not.toBe(undefined);
    // Keeping again replaces the value in the same row.
    const again = yield* service.keepPrivateKey!({
      use: { kind: "connector", id: connectorId, name: "Example MCP" },
      sites: [origin],
      auth: { type: "bearer" },
      value: Redacted.make("replacement-value"),
    });
    expect(again).toBe(accountId);
    expect(secretEquals(yield* service.resolveBound(ref, own), "replacement-value")).toBe(true);
  }),
);

it.effect("a key kept for one text generator serves no other use", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    const accountId = yield* service.keepPrivateKey!({
      use: { kind: "text-generator", id: "titles", name: "Titles" },
      sites: ["https://openrouter.ai"],
      auth: { type: "bearer" },
      value: Redacted.make(syntheticValue()),
    });
    const generator = {
      id: "titles",
      kind: "openaiCompatible" as const,
      baseUrl: "https://openrouter.ai/api/v1",
    };
    yield* service.resolveTextGeneratorKey(accountId, generator);
    const refused = [
      Effect.asVoid(service.resolveTextGeneratorKey(accountId, { ...generator, id: "other" })),
      Effect.asVoid(service.resolveSpeechKey(accountId, "https://openrouter.ai")),
      Effect.asVoid(service.resolveCustomModelAccountKey(accountId, "https://openrouter.ai")),
    ];
    for (const other of refused) expect((yield* Effect.flip(other)).reason).toBe("denied");
    const row = (yield* service.snapshot).accounts.find(
      (account) => account.accountId === accountId,
    )!;
    expect(libraryKeyFits("openAlex", { ...row, details: { ...row.details } })).toBe(false);
  }),
);

it.effect("keeps a key for a use whose name is longer than an account name may be", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    const name = "A connector with a long name ".repeat(4).slice(0, 100);
    const accountId = yield* service.keepPrivateKey!({
      use: { kind: "connector", id: connectorId, name },
      sites: [origin],
      auth: { type: "bearer" },
      value: Redacted.make(syntheticValue()),
    });
    const row = (yield* service.snapshot).accounts.find(
      (account) => account.accountId === accountId,
    );
    expect(row?.name.length).toBeLessThanOrEqual(80);
  }),
);

it.effect("a kept key's typed digest stays in the server, never in a snapshot", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    const value = syntheticValue();
    const use = { kind: "text-generator" as const, id: "titles" };
    yield* service.keepPrivateKey!({
      use: { ...use, name: "Titles" },
      sites: ["https://openrouter.ai"],
      auth: { type: "bearer" },
      value: Redacted.make(value),
    });
    const sent = [yield* service.snapshot, yield* service.forSession(scope)];
    expect(JSON.stringify(sent)).not.toContain(typedDigest(value));
    // Accounts still tells the use its typed value was kept.
    expect(yield* service.keptKeyState!(use, Redacted.make(value))).toBe("kept");
    expect(yield* service.keptKeyState!(use, Redacted.make("another-value"))).toBe("changed");
  }),
);

it.effect("Undo of a removed kept key gives it back to its use", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    const value = syntheticValue();
    const use = { kind: "text-generator" as const, id: "titles" };
    const accountId = yield* service.keepPrivateKey!({
      use: { ...use, name: "Titles" },
      sites: ["https://openrouter.ai"],
      auth: { type: "bearer" },
      value: Redacted.make(value),
    });
    const { removalId } = yield* service.remove(accountId);
    expect(yield* service.keptKeyState!(use, Redacted.make(value))).toBe("removed");
    yield* service.restore(accountId, removalId);
    expect(yield* service.keptKeyState!(use, Redacted.make(value))).toBe("kept");
  }),
);
