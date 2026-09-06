import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { applyPiModelSelection } from "./PiModelSelection.ts";
import { PiRpcCommandError, type PiRpcClient } from "./PiRpcClient.ts";
import type { PiRpcModel, PiRpcState, PiThinkingLevel } from "./PiRpcSchema.ts";

const selected = { provider: "test", modelId: "reasoner" };
const assert: typeof NodeAssert = NodeAssert;

it.effect("uses the shared enabled default for fresh sessions without a documented default", () =>
  Effect.gen(function* () {
    const { client } = makeClient();
    const result = yield* applyPiModelSelection(client, selected, undefined, { messageCount: 0 });
    assert.equal(result.confirmedThinkingLevel, "high");
  }),
);

it.effect("accepts supported implicit clamping and reports the effective level", () =>
  Effect.gen(function* () {
    const { client } = makeClient(knownMetadata);
    const clampingClient = {
      ...client,
      setModel: (provider: string, id: string) =>
        client.setModel(provider, id).pipe(Effect.tap(() => client.setThinkingLevel("off"))),
    };
    const result = yield* applyPiModelSelection(clampingClient, selected, undefined, {
      messageCount: 3,
    });
    assert.equal(result.confirmedThinkingLevel, "off");
    assert.equal(result.state.thinkingLevel, "off");
  }),
);

for (const supported of [false, true]) {
  it.effect(
    `allows custom models without effort controls (supported=${supported}) without claiming off`,
    () =>
      Effect.gen(function* () {
        const { client, calls } = makeClient({
          ...knownMetadata,
          supported,
          levels: [],
          mode: "budget",
        });
        yield* client.setThinkingLevel("off");
        calls.length = 0;
        const noControls = { ...client, getThinkingLevels: () => Effect.succeed({ levels: [] }) };
        const result = yield* applyPiModelSelection(noControls, selected, undefined, {
          messageCount: 0,
        });
        assert.equal(result.state.thinkingLevel, "off");
        assert.equal(result.confirmedThinkingLevel, undefined);
        assert.deepEqual(calls, ["model:reasoner", "state"]);
        const explicit = yield* applyPiModelSelection(noControls, selected, "off").pipe(
          Effect.result,
        );
        assert.equal(explicit._tag, "Failure");
      }),
  );
}

for (const messageCount of [0, 3, undefined]) {
  it.effect(
    `only applies an implicit model default to confirmed fresh sessions (${messageCount})`,
    () =>
      Effect.gen(function* () {
        const { client, calls } = makeClient(knownMetadata);
        yield* client.setThinkingLevel("off");
        calls.length = 0;
        const result = yield* applyPiModelSelection(client, selected, undefined, { messageCount });
        assert.equal(result.confirmedThinkingLevel, messageCount === 0 ? "high" : "off");
        assert.equal(calls.includes("thinking:high"), messageCount === 0);
      }),
  );
}

for (const defaultLevel of ["high", "off"] as const) {
  it.effect(`resolves explicit default to ${defaultLevel} even on existing sessions`, () =>
    Effect.gen(function* () {
      const { client } = makeClient({ ...knownMetadata, defaultLevel });
      const result = yield* applyPiModelSelection(client, selected, "default", { messageCount: 3 });
      assert.equal(result.confirmedThinkingLevel, defaultLevel);
    }),
  );
}

it.effect("does not invent an unknown default", () =>
  Effect.gen(function* () {
    const { client, calls } = makeClient();
    const result = yield* applyPiModelSelection(client, selected, "default").pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure")
      assert.match(result.failure.detail, /Default reasoning level is not known/);
    assert.deepEqual(calls, ["model:reasoner"]);
  }),
);

it.effect("validates a metadata default against the actual runtime ladder", () =>
  Effect.gen(function* () {
    const { client } = makeClient({ ...knownMetadata, defaultLevel: "max" });
    const result = yield* applyPiModelSelection(client, selected, "default").pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.match(result.failure.detail, /not supported/);
  }),
);

it.effect("does not claim runtime off is provider off for unknown custom reasoning", () =>
  Effect.gen(function* () {
    const { client } = makeClient({
      ...knownMetadata,
      status: "unknown",
      source: "unknown",
      supported: null,
      levels: [],
    });
    yield* client.setThinkingLevel("off");
    const result = yield* applyPiModelSelection(
      { ...client, getThinkingLevels: () => Effect.succeed({ levels: [] }) },
      selected,
      undefined,
      { messageCount: 0 },
    );
    assert.equal(result.state.thinkingLevel, "off");
    assert.equal(result.confirmedThinkingLevel, undefined);
  }),
);

const knownMetadata = {
  status: "known",
  source: "manual",
  checkedAt: "2026-09-06T00:00:00Z",
  stale: false,
  supported: true,
  levels: ["off", "high"],
  defaultLevel: "high",
} as const;

function makeClient(reasoningMetadata?: PiRpcModel["reasoningMetadata"]) {
  let state: PiRpcState = {};
  const calls: string[] = [];
  const client: Pick<
    PiRpcClient,
    "setModel" | "getThinkingLevels" | "setThinkingLevel" | "getState"
  > = {
    setModel: (provider, id) =>
      Effect.sync(() => {
        calls.push(`model:${id}`);
        state = { ...state, model: { provider, id, reasoningMetadata } };
        return state.model!;
      }),
    getThinkingLevels: () =>
      Effect.sync(() => {
        calls.push("levels");
        return {
          levels: (state.model?.id === "reasoner" ? ["off", "high"] : ["off"]) as PiThinkingLevel[],
        };
      }),
    setThinkingLevel: (thinkingLevel) =>
      Effect.sync(() => {
        calls.push(`thinking:${thinkingLevel}`);
        state = { ...state, thinkingLevel };
      }),
    getState: () =>
      Effect.sync(() => {
        calls.push("state");
        return state;
      }),
  };
  return { client, calls };
}

it.effect("uses fresh levels after each model switch", () =>
  Effect.gen(function* () {
    const { client, calls } = makeClient();
    const confirmed = yield* applyPiModelSelection(client, selected, "high");
    assert.equal(confirmed.state.thinkingLevel, "high");
    assert.deepEqual(confirmed.supportedThinkingLevels, ["off", "high"]);
    const result = yield* applyPiModelSelection(
      client,
      { ...selected, modelId: "plain" },
      "high",
    ).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.kind, "validation");
    assert.deepEqual(calls, [
      "model:reasoner",
      "levels",
      "thinking:high",
      "state",
      "model:plain",
      "levels",
    ]);
  }),
);

it.effect("keeps unknown inherited thinking unknown and applies explicit off", () =>
  Effect.gen(function* () {
    const { client, calls } = makeClient();
    const inherited = yield* applyPiModelSelection(client, selected, undefined);
    assert.equal(inherited.state.thinkingLevel, undefined);
    assert.deepEqual(calls, ["model:reasoner", "levels", "state"]);
    const explicit = yield* applyPiModelSelection(client, selected, "off");
    assert.equal(explicit.state.thinkingLevel, "off");
    assert.equal(calls.includes("thinking:off"), true);
  }),
);

it.effect("returns confirmed inherited thinking without setting a default", () =>
  Effect.gen(function* () {
    const { client, calls } = makeClient();
    yield* applyPiModelSelection(client, selected, "high");
    calls.length = 0;
    const inherited = yield* applyPiModelSelection(client, selected, undefined);
    assert.equal(inherited.state.thinkingLevel, "high");
    assert.deepEqual(calls, ["model:reasoner", "levels", "state"]);
  }),
);

it.effect("repairs an invalid inherited level once using the new model's qualified ladder", () =>
  Effect.gen(function* () {
    const { client, calls } = makeClient();
    yield* applyPiModelSelection(client, selected, "high");
    calls.length = 0;
    const result = yield* applyPiModelSelection(
      client,
      { ...selected, modelId: "plain" },
      undefined,
    ).pipe(Effect.result);
    assert.equal(result._tag, "Success");
    if (result._tag === "Success") assert.equal(result.success.confirmedThinkingLevel, "off");
    assert.deepEqual(calls, ["model:plain", "levels", "state", "thinking:off", "state"]);
  }),
);

it.effect("does not loop when implicit repair is ignored by the runtime", () =>
  Effect.gen(function* () {
    const { client, calls } = makeClient();
    yield* client.setModel(selected.provider, selected.modelId);
    yield* client.setThinkingLevel("high");
    const drift = {
      ...client,
      getThinkingLevels: () => Effect.succeed({ levels: ["low" as const] }),
      setThinkingLevel: () =>
        Effect.sync(() => {
          calls.push("ignored");
        }),
    };
    const result = yield* applyPiModelSelection(drift, selected, undefined).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(calls.filter((call) => call === "ignored").length, 1);
  }),
);

for (const state of [
  {},
  { model: { provider: "other", id: "reasoner" }, thinkingLevel: "high" },
  { model: { provider: "test", id: "other" }, thinkingLevel: "high" },
  { model: { provider: "test", id: "reasoner" }, thinkingLevel: "off" },
  { model: { provider: "test", id: "reasoner" } },
] satisfies PiRpcState[]) {
  it.effect(`rejects runtime mismatch ${JSON.stringify(state)}`, () =>
    Effect.gen(function* () {
      const { client } = makeClient();
      const result = yield* applyPiModelSelection(
        { ...client, getState: () => Effect.succeed(state) },
        selected,
        "high",
      ).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.kind, "request");
        assert.equal(result.failure.command, "get_state");
        assert.match(result.failure.detail, /did not apply/);
      }
    }),
  );
}

it.effect("rejects invalid thinking before mutating runtime", () =>
  Effect.gen(function* () {
    const { client, calls } = makeClient();
    const result = yield* applyPiModelSelection(client, selected, "invented").pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.kind, "validation");
    assert.deepEqual(calls, []);
  }),
);

for (const [method, command] of [
  ["setModel", "set_model"],
  ["getThinkingLevels", "get_available_thinking_levels"],
  ["setThinkingLevel", "set_thinking_level"],
  ["getState", "get_state"],
] as const) {
  it.effect(`preserves RPC failure cause and command for ${method}`, () =>
    Effect.gen(function* () {
      const { client } = makeClient();
      const cause = new PiRpcCommandError({
        command,
        requestId: "test",
        detail: "runtime refused",
      });
      const result = yield* applyPiModelSelection(
        { ...client, [method]: () => Effect.fail(cause) },
        selected,
        "high",
      ).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.kind, "request");
        assert.equal(result.failure.command, command);
        assert.equal(result.failure.cause, cause);
      }
    }),
  );
}
