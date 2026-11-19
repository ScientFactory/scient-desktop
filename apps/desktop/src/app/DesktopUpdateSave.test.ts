import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { make } from "./DesktopUpdateSave.ts";
import { PREPARE_UPDATE_SAVE_CHANNEL, RELEASE_UPDATE_SAVE_CHANNEL } from "../ipc/channels.ts";

const fixture = Effect.gen(function* () {
  const requests = yield* Queue.unbounded<{ id: number; requestId: string }>();
  const state = {
    destroyed: new Set<number>(),
    changedFrame: false,
    boundsFlushed: false,
    locked: new Set<number>(),
  };
  const frames = [{}, {}];
  const fakeWindows = frames.map((frame, index) => {
    const id = index + 1;
    return {
      isDestroyed: () => state.destroyed.has(id),
      webContents: {
        id,
        get mainFrame() {
          return state.changedFrame ? {} : frame;
        },
        isDestroyed: () => state.destroyed.has(id),
        send: (channel: string, input: { requestId: string; lockForRestart: boolean } | string) => {
          if (channel === RELEASE_UPDATE_SAVE_CHANNEL) {
            state.locked.delete(id);
            return;
          }
          assert.equal(channel, PREPARE_UPDATE_SAVE_CHANNEL);
          assert.isTrue(state.boundsFlushed);
          assert.notEqual(typeof input, "string");
          const request = input as { requestId: string; lockForRestart: boolean };
          if (request.lockForRestart) state.locked.add(id);
          Queue.offerUnsafe(requests, { id, requestId: request.requestId });
        },
      },
    } as unknown as Electron.BrowserWindow;
  });
  const service = yield* make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ElectronWindow.ElectronWindow, { appWindows: Effect.succeed(fakeWindows) }),
        Layer.mock(DesktopWindow.DesktopWindow, {
          flushMainWindowBounds: Effect.sync(() => {
            state.boundsFlushed = true;
          }),
        }),
        NodeCrypto.layer,
      ),
    ),
  );
  return { service, requests, frames, state };
});

it.effect(
  "requires saved acknowledgements from every captured app window and rejects wrong identities",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      assert.isFalse(
        yield* f.service.acknowledge({
          requestId: "unsolicited",
          senderId: 1,
          senderFrame: f.frames[0],
          saved: true,
        }),
      );
      const pending = yield* f.service.prepare.pipe(Effect.forkChild);
      const first = yield* Queue.take(f.requests);
      const second = yield* Queue.take(f.requests);
      assert.equal(first.requestId, second.requestId);
      const ack = {
        requestId: first.requestId,
        senderId: first.id,
        senderFrame: f.frames[first.id - 1],
        saved: true,
      };
      assert.isFalse(yield* f.service.acknowledge({ ...ack, requestId: "old-request" }));
      assert.isFalse(yield* f.service.acknowledge({ ...ack, senderFrame: {} }));
      assert.isFalse(yield* f.service.acknowledge({ ...ack, senderId: 99 }));
      assert.isTrue(yield* f.service.acknowledge(ack));
      assert.isFalse(yield* f.service.acknowledge(ack));
      assert.isTrue(
        yield* f.service.acknowledge({
          ...ack,
          senderId: second.id,
          senderFrame: f.frames[second.id - 1],
        }),
      );
      assert.isTrue(yield* Fiber.join(pending));
      assert.isFalse(yield* f.service.acknowledge(ack));
    }).pipe(Effect.scoped),
);

it.effect.each(["save-failed", "destroyed", "reloaded"] as const)(
  "fails closed when a captured window is %s",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const pending = yield* f.service.prepare.pipe(Effect.forkChild);
      const first = yield* Queue.take(f.requests);
      const second = yield* Queue.take(f.requests);
      if (kind === "destroyed") f.state.destroyed.add(second.id);
      if (kind === "reloaded") f.state.changedFrame = true;
      yield* f.service.acknowledge({
        requestId: first.requestId,
        senderId: first.id,
        senderFrame: f.frames[first.id - 1],
        saved: true,
      });
      yield* f.service.acknowledge({
        requestId: second.requestId,
        senderId: second.id,
        senderFrame: f.frames[second.id - 1],
        saved: kind !== "save-failed",
      });
      assert.isFalse(yield* Fiber.join(pending));
    }).pipe(Effect.scoped),
);

it.effect(
  "times out an unresponsive window and requires fresh acknowledgements for the final reflush",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const pending = yield* f.service.prepare.pipe(Effect.forkChild);
      const old = yield* Queue.take(f.requests);
      yield* Queue.take(f.requests);
      yield* TestClock.adjust("20 seconds");
      assert.isFalse(yield* Fiber.join(pending));
      const final = yield* f.service.prepare.pipe(Effect.forkChild);
      const first = yield* Queue.take(f.requests);
      const second = yield* Queue.take(f.requests);
      assert.notEqual(first.requestId, old.requestId);
      assert.isFalse(
        yield* f.service.acknowledge({
          requestId: old.requestId,
          senderId: old.id,
          senderFrame: f.frames[old.id - 1],
          saved: true,
        }),
      );
      for (const request of [first, second])
        yield* f.service.acknowledge({
          requestId: request.requestId,
          senderId: request.id,
          senderFrame: f.frames[request.id - 1],
          saved: true,
        });
      assert.isTrue(yield* Fiber.join(final));
    }).pipe(Effect.scoped),
);

it.effect(
  "holds final-save input locks through handoff and releases them after native failure",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const pending = yield* f.service.prepareForRestart.pipe(Effect.forkChild);
      const first = yield* Queue.take(f.requests);
      const second = yield* Queue.take(f.requests);
      assert.deepEqual([...f.state.locked], [1, 2]);
      for (const request of [first, second])
        yield* f.service.acknowledge({
          requestId: request.requestId,
          senderId: request.id,
          senderFrame: f.frames[request.id - 1],
          saved: true,
        });
      assert.isTrue(yield* Fiber.join(pending));
      assert.deepEqual([...f.state.locked], [1, 2]);
      yield* f.service.release;
      assert.deepEqual([...f.state.locked], []);
    }).pipe(Effect.scoped),
);

it.effect("unlocks every captured window when the final-save acknowledgement times out", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const pending = yield* f.service.prepareForRestart.pipe(Effect.forkChild);
    yield* Queue.take(f.requests);
    yield* Queue.take(f.requests);
    yield* TestClock.adjust("20 seconds");
    assert.isFalse(yield* Fiber.join(pending));
    assert.deepEqual([...f.state.locked], []);
  }).pipe(Effect.scoped),
);

it.effect("allows a consented macOS update when the last app window is already closed", () =>
  Effect.gen(function* () {
    const service = yield* make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ElectronWindow.ElectronWindow, { appWindows: Effect.succeed([]) }),
          Layer.mock(DesktopWindow.DesktopWindow, { flushMainWindowBounds: Effect.void }),
          NodeCrypto.layer,
        ),
      ),
    );
    assert.isTrue(yield* service.prepare);
    assert.isTrue(yield* service.prepareForRestart);
  }).pipe(Effect.scoped),
);
