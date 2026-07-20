import { EventEmitter } from "node:events";

import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { waitForDesktopParentShutdown } from "./desktopParentShutdown";

describe("waitForDesktopParentShutdown", () => {
  it("ignores unrelated messages and completes for the shutdown protocol", async () => {
    const source = new EventEmitter();
    const fiber = Effect.runFork(waitForDesktopParentShutdown(source));
    await new Promise((resolve) => setImmediate(resolve));

    source.emit("message", { type: "other" });
    expect(fiber.pollUnsafe()).toBeUndefined();
    source.emit("message", { type: "scient.backend.shutdown", reason: "app quit" });

    await Effect.runPromise(Fiber.join(fiber));
    expect(fiber.pollUnsafe()).toBeDefined();
    expect(source.listenerCount("message")).toBe(0);
  });

  it("removes its listener when the server scope is interrupted", async () => {
    const source = new EventEmitter();
    const fiber = Effect.runFork(waitForDesktopParentShutdown(source));
    await new Promise((resolve) => setImmediate(resolve));

    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(source.listenerCount("message")).toBe(0);
  });
});
