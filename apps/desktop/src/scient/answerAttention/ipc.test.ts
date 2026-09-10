import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { setUnreadAnswerCount } from "./ipc.ts";

const { setBadgeCount, dock } = vi.hoisted(() => ({ setBadgeCount: vi.fn(() => true), dock: {} }));
vi.mock("electron", () => ({ app: { dock, setBadgeCount } }));
const run = (count: unknown, sender = 7) =>
  setUnreadAnswerCount.handler(count, { sender: { id: sender } }).pipe(
    Effect.provideService(ElectronWindow, {
      main: Effect.succeed(Option.some({ webContents: { id: 7 } })),
    } as unknown as ElectronWindow["Service"]),
  );
beforeEach(() => setBadgeCount.mockClear());
it.effect("sets and clears the native badge from the main renderer", () =>
  Effect.gen(function* () {
    expect(yield* run(2)).toBe(true);
    expect(yield* run(0)).toBe(true);
    expect(setBadgeCount.mock.calls).toEqual([[2], [0]]);
  }),
);
it.effect("rejects guest renderers", () =>
  Effect.gen(function* () {
    expect(yield* run(5, 99)).toBe(false);
    expect(setBadgeCount).not.toHaveBeenCalled();
  }),
);
it.effect("rejects invalid counts before calling the native API", () =>
  Effect.gen(function* () {
    for (const count of [-1, 1.5, NaN, Infinity, "3", 1_000_001]) {
      expect((yield* Effect.result(run(count)))._tag).toBe("Failure");
    }
    expect(setBadgeCount).not.toHaveBeenCalled();
  }),
);
