// @effect-diagnostics nodeBuiltinImport:off -- Exercises native writable-stream events.
import * as NodeStream from "node:stream";

import { describe, expect, it } from "@effect/vitest";

import { waitForWritableDrain } from "./waitForWritableDrain.ts";

describe("waitForWritableDrain", () => {
  it("resolves on drain and removes its listeners", async () => {
    const stream = new NodeStream.PassThrough();
    const waiting = waitForWritableDrain(stream);
    stream.emit("drain");
    await expect(waiting).resolves.toBeUndefined();
    expect(stream.listenerCount("drain")).toBe(0);
    expect(stream.listenerCount("error")).toBe(0);
    expect(stream.listenerCount("close")).toBe(0);
  });

  it("rejects on an output error or early close", async () => {
    const failed = new NodeStream.PassThrough();
    const error = new Error("disk write failed");
    const errorWait = waitForWritableDrain(failed);
    failed.emit("error", error);
    await expect(errorWait).rejects.toBe(error);
    expect(failed.listenerCount("drain")).toBe(0);

    const closed = new NodeStream.PassThrough();
    const closeWait = waitForWritableDrain(closed);
    closed.emit("close");
    await expect(closeWait).rejects.toThrow("closed before it drained");
    expect(closed.listenerCount("error")).toBe(0);
  });
});
