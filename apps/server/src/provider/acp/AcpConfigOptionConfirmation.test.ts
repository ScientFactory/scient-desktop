// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/**
 * A raw JSON-RPC agent whose answer to each `session/set_config_option` is
 * scripted, so the order of the response and of `config_option_update`
 * notifications on the wire is exact: consecutive steps go out in one write.
 * Droid 0.213.0 and 0.230.0 answer `{}` and then publish one update.
 */
const AGENT_SOURCE = String.raw`
import * as fs from "node:fs";
const plan = JSON.parse(process.env.ACP_PLAN ?? "[]");
const state = { model: "a", autonomy_level: "normal" };
const select = (id, values) => ({
  id, name: id, type: "select", currentValue: state[id],
  ...(id === "model" ? { category: "model" } : {}),
  options: values.map((value) => ({ value, name: value })),
});
const options = () => [select("model", ["a", "b", "c"]), select("autonomy_level", ["normal", "auto-high"])];
const line = (message) => JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n";
const writes = [];
let promptId;
const run = async (index) => {
  let chunk = "";
  const flush = () => { if (chunk) process.stdout.write(chunk); chunk = ""; };
  for (const step of plan[index] ?? []) {
    if (step.sleep !== undefined) {
      flush();
      await new Promise((resolve) => setTimeout(resolve, step.sleep));
    } else if (step.respond === "prompt") {
      chunk += line({ id: promptId, result: { stopReason: "end_turn" } });
    } else if (step.respond === "malformed") {
      chunk += line({ id: writes[index].id, result: { configOptions: "not a list" } });
    } else if (step.respond === "rejected") {
      chunk += line({ id: writes[index].id, error: { code: -32602, message: "Not offered." } });
    } else if (step.respond !== undefined) {
      chunk += line({ id: writes[index].id, result: {} });
    } else {
      const write = writes[index];
      Object.assign(state, step.update === "requested" ? { [write.configId]: write.value } : step.update);
      chunk += line({
        method: "session/update",
        params: { sessionId: "s", update: { sessionUpdate: "config_option_update", configOptions: options() } },
      });
    }
  }
  flush();
};
let buffer = "";
process.stdin.on("data", (data) => {
  buffer += data;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.method === "initialize")
      process.stdout.write(line({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } }));
    else if (message.method === "session/new")
      process.stdout.write(line({ id: message.id, result: { sessionId: "s", configOptions: options() } }));
    else if (message.method === "session/prompt") promptId = message.id;
    else if (message.method === "session/set_config_option") {
      writes.push({ id: message.id, configId: message.params.configId, value: message.params.value });
      fs.appendFileSync(process.env.ACP_WRITES, message.params.value + "\n");
      void run(writes.length - 1);
    }
  }
});
`;

type Step =
  | { readonly respond: true | "prompt" | "malformed" | "rejected" }
  | { readonly update: "requested" | Record<string, string> }
  | { readonly sleep: number };
const RESPOND: Step = { respond: true };
const APPLY: Step = { update: "requested" };
const encodePlan = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const scriptedRuntime = (
  plan: ReadonlyArray<ReadonlyArray<Step>>,
  settleTimeout = "30 seconds",
  configOptionTransport: "request" | "request-confirmed" = "request-confirmed",
) =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-config-order-"))),
      (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
    );
    const agent = NodePath.join(directory, "agent.mjs");
    const writes = NodePath.join(directory, "writes");
    NodeFS.writeFileSync(agent, AGENT_SOURCE);
    NodeFS.writeFileSync(writes, "");
    const runtime = yield* AcpSessionRuntime.make({
      spawn: {
        command: process.execPath,
        args: [agent],
        env: { ACP_PLAN: encodePlan(plan), ACP_WRITES: writes },
      },
      cwd: directory,
      clientInfo: { name: "t3-test", version: "0.0.0" },
      authMethodId: undefined,
      configOptionTransport,
      configOptionSettleTimeout: settleTimeout as never,
    });
    yield* runtime.start();
    return {
      ...runtime,
      /** The values of the writes that reached the agent. */
      writesReceived: () => NodeFS.readFileSync(writes, "utf8").split("\n").filter(Boolean),
    };
  });

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const exit = yield* Effect.exit(effect);
    return { exit, elapsed: (yield* Clock.currentTimeMillis) - startedAt };
  });
const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
const currentValue = (runtime: AcpSessionRuntime.AcpSessionRuntime["Service"], id: string) =>
  runtime.getConfigOptions.pipe(
    Effect.map((options) => options.find((option) => option.id === id)?.currentValue),
  );
const live = <A, E>(name: string, body: () => Effect.Effect<A, E, never>) =>
  it.live(name, body, 20_000);
const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const NO_ANSWER =
  'The agent did not answer the change of autonomy_level to "auto-high" within 0.4 s, so its session was closed.';

describe("unconfirmed config writes", () => {
  live("keep the inventory an agent published before its empty acknowledgement", () =>
    scoped(
      Effect.gen(function* () {
        // Agents other than Droid may publish first; the `{}` that follows
        // must not replace what the update reported.
        const runtime = yield* scriptedRuntime(
          [[{ update: { model: "b", autonomy_level: "auto-high" } }, RESPOND]],
          "30 seconds",
          "request",
        );
        yield* runtime.setConfigOption("model", "b");
        expect(yield* currentValue(runtime, "model")).toBe("b");
        expect(yield* currentValue(runtime, "autonomy_level")).toBe("auto-high");
      }),
    ),
  );
});

describe("confirmed config writes", () => {
  live("confirms from the update that follows the response, back to back", () =>
    scoped(
      Effect.gen(function* () {
        const runtime = yield* scriptedRuntime([[RESPOND, APPLY]]);
        const { exit, elapsed } = yield* timed(runtime.setModel("b"));
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(yield* currentValue(runtime, "model")).toBe("b");
        expect(elapsed).toBeLessThan(2_000);
      }),
    ),
  );

  live("fails at once on a mismatch that arrives back to back with the response", () =>
    scoped(
      Effect.gen(function* () {
        const runtime = yield* scriptedRuntime(
          [[RESPOND, { update: { model: "c" } }]],
          "4 seconds",
        );
        const { exit, elapsed } = yield* timed(runtime.setModel("b"));
        const error = failure(exit);
        expect(error).toBeInstanceOf(EffectAcpErrors.AcpRequestError);
        expect((error as Error).message).toBe('The agent applied model "c" instead of "b".');
        expect(elapsed).toBeLessThan(2_000);
      }),
    ),
  );

  live("does not confirm from a matching update that precedes the response", () =>
    scoped(
      Effect.gen(function* () {
        // The update before the response belongs to an earlier write; the
        // agent's own report for this write follows its response.
        const runtime = yield* scriptedRuntime([[APPLY, RESPOND, { update: { model: "c" } }]]);
        const { exit } = yield* timed(runtime.setModel("b"));
        expect((failure(exit) as Error | undefined)?.message).toBe(
          'The agent applied model "c" instead of "b".',
        );
      }),
    ),
  );

  live("is not failed by another value reported before the response", () =>
    scoped(
      Effect.gen(function* () {
        const runtime = yield* scriptedRuntime([
          [{ update: { autonomy_level: "auto-high" } }, RESPOND, APPLY],
        ]);
        const { exit } = yield* timed(runtime.setModel("b"));
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(yield* currentValue(runtime, "model")).toBe("b");
      }),
    ),
  );

  // Droid 0.183.0, 0.200.0, 0.213.0 and 0.230.0 all answer before they publish
  // the applied state, so nothing reported before (or without) the answer counts.
  for (const [name, steps, message] of [
    [
      "without an answer",
      [APPLY],
      'The agent did not answer the change of model to "b" within 0.4 s, so its session was closed.',
    ],
    [
      "that precedes the answer",
      [APPLY, RESPOND],
      'The agent answered the change of model to "b" but did not report the applied value within 0.4 s, so its session was closed.',
    ],
    [
      "that a later one contradicts before the answer",
      [APPLY, { update: { model: "c" } }, RESPOND],
      'The agent answered the change of model to "b" but did not report the applied value within 0.4 s, so its session was closed.',
    ],
  ] as const)
    live(`does not confirm from a matching update ${name}`, () =>
      scoped(
        Effect.gen(function* () {
          const runtime = yield* scriptedRuntime([steps], "400 millis");
          const { exit } = yield* timed(runtime.setModel("b"));
          const error = failure(exit);
          expect(error).toBeInstanceOf(EffectAcpErrors.AcpRequestError);
          expect((error as Error).message).toBe(message);
        }),
      ),
    );

  live("does not take the answer to another request for the write's own", () =>
    scoped(
      Effect.gen(function* () {
        // A prompt's answer and an update arrive before the write's answer and report.
        const runtime = yield* scriptedRuntime([
          [{ respond: "prompt" }, APPLY, RESPOND, { update: { model: "c" } }],
        ]);
        yield* runtime.prompt({ prompt: [{ type: "text", text: "hi" }] }).pipe(Effect.forkScoped);
        yield* Effect.sleep("200 millis");
        const { exit } = yield* timed(runtime.setModel("b"));
        expect((failure(exit) as Error | undefined)?.message).toBe(
          'The agent applied model "c" instead of "b".',
        );
      }),
    ),
  );

  // A write that ended without the agent's report leaves its settings unknown,
  // and its late report would pass for the next write's: nothing more is sent.
  live("ends the connection when the agent answered a write but reported it too late", () =>
    scoped(
      Effect.gen(function* () {
        // The first write's report arrives right behind the second write's answer.
        const runtime = yield* scriptedRuntime(
          [
            [RESPOND, { sleep: 600 }, APPLY],
            [RESPOND, { sleep: 300 }, { update: { model: "c" } }],
          ],
          "400 millis",
        );
        const first = yield* timed(runtime.setModel("b"));
        expect((failure(first.exit) as Error | undefined)?.message).toBe(
          'The agent answered the change of model to "b" but did not report the applied value within 0.4 s, so its session was closed.',
        );
        const second = yield* timed(runtime.setModel("b"));
        expect((failure(second.exit) as Error | undefined)?.message).toBe(
          'The agent answered the change of model to "b" but did not report the applied value within 0.4 s, so its session was closed.',
        );
        expect(second.elapsed).toBeLessThan(300);
        yield* Effect.sleep("700 millis");
        expect(runtime.writesReceived()).toEqual(["b"]);
      }),
    ),
  );

  live("ends the connection when the agent never answered a write", () =>
    scoped(
      Effect.gen(function* () {
        const runtime = yield* scriptedRuntime([[], [RESPOND, APPLY]], "400 millis");
        const first = yield* timed(runtime.setConfigOption("autonomy_level", "auto-high"));
        expect((failure(first.exit) as Error | undefined)?.message).toBe(NO_ANSWER);
        const second = yield* timed(runtime.setConfigOption("autonomy_level", "auto-high"));
        expect((failure(second.exit) as Error | undefined)?.message).toBe(NO_ANSWER);
        expect(second.elapsed).toBeLessThan(300);
        expect(runtime.writesReceived()).toEqual(["auto-high"]);
      }),
    ),
  );

  live("ends the connection when the agent's answer to a write is not a valid one", () =>
    scoped(
      Effect.gen(function* () {
        // Neither a report nor a rejection: the write's own report can still arrive,
        // here right behind the next write's answer.
        const runtime = yield* scriptedRuntime([
          [{ respond: "malformed" }, { sleep: 300 }, APPLY],
          [RESPOND, { sleep: 600 }, { update: { model: "c" } }],
        ]);
        const first = yield* timed(runtime.setModel("b"));
        expect((failure(first.exit) as Error | undefined)?.message).toBe(
          'The agent\'s answer to the change of model to "b" was not a valid one, so its session was closed.',
        );
        const second = yield* timed(runtime.setModel("b"));
        expect((failure(second.exit) as Error | undefined)?.message).toBe(
          'The agent\'s answer to the change of model to "b" was not a valid one, so its session was closed.',
        );
        expect(second.elapsed).toBeLessThan(300);
        yield* Effect.sleep("700 millis");
        expect(runtime.writesReceived()).toEqual(["b"]);
      }),
    ),
  );

  live("stays usable after a write the agent rejected or reported with another value", () =>
    scoped(
      Effect.gen(function* () {
        // Both say what the agent runs with: nothing of these writes is still to come.
        const runtime = yield* scriptedRuntime([
          [{ respond: "rejected" }],
          [RESPOND, { update: { model: "c" } }],
          [RESPOND, APPLY],
        ]);
        const rejected = yield* timed(runtime.setModel("b"));
        expect((failure(rejected.exit) as Error | undefined)?.message).toBe("Not offered.");
        const replaced = yield* timed(runtime.setModel("b"));
        expect((failure(replaced.exit) as Error | undefined)?.message).toBe(
          'The agent applied model "c" instead of "b".',
        );
        const confirmed = yield* timed(runtime.setModel("b"));
        expect(Exit.isSuccess(confirmed.exit)).toBe(true);
        expect(yield* currentValue(runtime, "model")).toBe("b");
        expect(runtime.writesReceived()).toEqual(["b", "b", "b"]);
      }),
    ),
  );

  live("ends the connection when a write is interrupted after it was sent", () =>
    scoped(
      Effect.gen(function* () {
        const runtime = yield* scriptedRuntime([
          [{ sleep: 300 }, RESPOND, { sleep: 100 }, APPLY],
          [RESPOND, { sleep: 600 }, { update: { model: "c" } }],
        ]);
        const first = yield* runtime.setModel("b").pipe(Effect.forkScoped);
        yield* Effect.sleep("150 millis");
        yield* Fiber.interrupt(first);
        const second = yield* timed(runtime.setModel("b"));
        expect((failure(second.exit) as Error | undefined)?.message).toBe(
          'The change of model to "b" was interrupted before the agent reported the applied value, so its session was closed.',
        );
        yield* Effect.sleep("700 millis");
        expect(runtime.writesReceived()).toEqual(["b"]);
      }),
    ),
  );
});
