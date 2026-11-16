import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeRestartTiming, type RestartTimingEvent } from "./DesktopRestartTiming.ts";

function fixture() {
  const state = { text: null as string | null, writable: true, sequence: 0 };
  const events: RestartTimingEvent[] = [];
  const process = (version: string, launchId: string, processStartedAt = 1_100) => {
    const clock = { wall: processStartedAt + 20, monotonic: 20 };
    const make = makeRestartTiming({
      appVersion: version,
      launchId,
      processStartedAt,
      now: Effect.sync(() => ({ ...clock })),
      processId: launchId === "source" ? 100 : 200,
      randomId: Effect.sync(() => `attempt-${++state.sequence}`),
      read: Effect.sync(() => state.text),
      write: (text) =>
        Effect.sync(() => {
          if (!state.writable) return false;
          state.text = text;
          return true;
        }),
      remove: Effect.sync(() => {
        state.text = null;
      }),
      emit: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    });
    return { make, clock };
  };
  const handoff = Effect.gen(function* () {
    const source = process("1.0.0", "source", 900);
    source.clock.wall = 1_000;
    source.clock.monotonic = 100;
    const timing = yield* source.make;
    yield* timing.begin("1.1.0");
    source.clock.wall = 1_010;
    source.clock.monotonic = 110;
    yield* timing.shutdownStarted;
    source.clock.wall = 1_040;
    source.clock.monotonic = 140;
    yield* timing.nativeHandoff;
    return timing;
  });
  return { state, events, process, handoff };
}

it.effect(
  "splits confirmation, safe stop, native handoff, target launch and usable workspace",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.handoff;
      const next = f.process("1.1.0", "target");
      const timing = yield* next.make;
      yield* timing.launch;
      const token = yield* timing.readinessToken;
      assert.deepEqual(token, { attemptId: "attempt-1", launchId: "target" });
      assert.isNotNull(token);
      const ack = { ...token!, projectRestored: true };
      assert.isFalse(yield* timing.workspaceReady(ack));
      yield* timing.backendReady;
      next.clock.wall = 1_180;
      next.clock.monotonic = 80;
      assert.isTrue(yield* timing.workspaceReady(ack));
      assert.deepEqual(
        f.events.map((event) => event.event),
        [
          "confirmed",
          "shutdown-started",
          "native-handoff",
          "launched",
          "backend-ready",
          "workspace-ready",
        ],
      );
      assert.equal(f.events[1]?.elapsedMs, 10);
      assert.equal(f.events[2]?.elapsedMs, 40);
      assert.equal(f.events[3]?.confirmToLaunchMs, 100);
      assert.equal(f.events[3]?.handoffToLaunchMs, 60);
      assert.deepInclude(f.events[5], {
        attemptId: "attempt-1",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        launchId: "target",
        processId: 200,
        confirmToReadyMs: 180,
        launchToBackendMs: 20,
        launchToReadyMs: 80,
        projectRestored: true,
      });
      assert.isNull(f.state.text);
      assert.isNull(yield* timing.readinessToken);
      assert.isFalse(yield* timing.workspaceReady(ack));
    }),
);

it.effect(
  "rejects wrong attempt and process acknowledgements and records readiness only once",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.handoff;
      const timing = yield* f.process("1.1.0", "target").make;
      yield* timing.launch;
      yield* timing.backendReady;
      yield* timing.backendReady;
      assert.isFalse(
        yield* timing.workspaceReady({
          attemptId: "other",
          launchId: "target",
          projectRestored: true,
        }),
      );
      assert.isFalse(
        yield* timing.workspaceReady({
          attemptId: "attempt-1",
          launchId: "old-process",
          projectRestored: true,
        }),
      );
      const ack = { attemptId: "attempt-1", launchId: "target", projectRestored: false };
      const outcomes = yield* Effect.all([timing.workspaceReady(ack), timing.workspaceReady(ack)], {
        concurrency: "unbounded",
      });
      assert.equal(outcomes.filter(Boolean).length, 1);
      assert.equal(f.events.filter((e) => e.event === "backend-ready").length, 1);
      assert.equal(f.events.filter((e) => e.event === "workspace-ready").length, 1);
    }),
);

it.effect.each([
  { version: "1.0.0", start: 1_100, reason: "version-mismatch" },
  { version: "1.2.0", start: 1_100, reason: "version-mismatch" },
  { version: "1.1.0", start: 999, reason: "expired-or-clock-changed" },
  { version: "1.1.0", start: 1_000_001, reason: "expired-or-clock-changed" },
])("never counts an unrelated or stale launch ($version, $start)", ({ version, start, reason }) =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.handoff;
    const timing = yield* f.process(version, "wrong", start).make;
    yield* timing.launch;
    yield* timing.backendReady;
    assert.isNull(yield* timing.readinessToken);
    assert.equal(f.events.at(-1)?.reason, reason);
    assert.isNull(f.state.text);
    assert.isFalse(f.events.some((e) => e.event === "workspace-ready" || e.event === "launched"));
  }),
);

it.effect(
  "does not let a later manual relaunch rescue a target process that never became usable",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.handoff;
      const first = yield* f.process("1.1.0", "first").make;
      yield* first.launch;
      yield* first.launch;
      const second = yield* f.process("1.1.0", "second", 1_200).make;
      yield* second.launch;
      assert.isNull(yield* second.readinessToken);
      assert.equal(f.events.filter((e) => e.event === "launched").length, 1);
      assert.equal(f.events.at(-1)?.reason, "not-handed-off-or-already-launched");
    }),
);

it.effect("abandons interrupted confirmation, cancellation and a failed persistence write", () =>
  Effect.gen(function* () {
    const f = fixture();
    const source = yield* f.process("1.0.0", "source", 900).make;
    yield* source.begin("1.1.0");
    yield* source.nativeHandoff;
    const interrupted = yield* f.process("1.1.0", "interrupted").make;
    yield* interrupted.launch;
    assert.isNull(yield* interrupted.readinessToken);
    assert.equal(f.events.at(-1)?.reason, "not-handed-off-or-already-launched");
    yield* source.begin("1.1.0");
    yield* source.cancel("install-failed");
    assert.isNull(f.state.text);
    f.state.writable = false;
    yield* source.begin("1.1.0");
    assert.equal(f.events.at(-1)?.reason, "persistence-failed");
    assert.isNull(yield* source.readinessToken);
  }),
);

it.effect(
  "keeps monotonic stop timing during a wall-clock correction and rejects stale readiness",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const source = f.process("1.0.0", "source", 900);
      const timing = yield* source.make;
      yield* timing.begin("1.1.0");
      source.clock.wall -= 100;
      source.clock.monotonic += 30;
      yield* timing.shutdownStarted;
      assert.equal(f.events.at(-1)?.elapsedMs, 30);
      yield* f.handoff;
      const target = f.process("1.1.0", "target");
      const next = yield* target.make;
      yield* next.launch;
      yield* next.backendReady;
      target.clock.wall = 999;
      assert.isFalse(
        yield* next.workspaceReady({
          attemptId: "attempt-2",
          launchId: "target",
          projectRestored: true,
        }),
      );
      assert.equal(f.events.at(-1)?.reason, "expired-or-clock-changed");
      assert.isFalse(f.events.some((e) => e.event === "workspace-ready"));
    }),
);

it.effect.each([
  '{"fromVersion":"1.0.0","targetVersion":"1.1.0","startedAt":1000}',
  '{"fromVersion":"1.0.0","targetVersion":"1.1.0"}',
  "not-json",
])("does not reinterpret legacy install-to-launch data as workspace readiness (%s)", (text) =>
  Effect.gen(function* () {
    const f = fixture();
    f.state.text = text;
    const timing = yield* f.process("1.1.0", "target").make;
    yield* timing.launch;
    assert.isNull(yield* timing.readinessToken);
    assert.deepEqual(f.events, []);
    assert.isNull(f.state.text);
  }),
);
