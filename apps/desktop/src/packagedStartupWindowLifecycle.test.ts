import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { attachPackagedStartupWindowLifecycleProof } from "./packagedStartupWindowLifecycle";

describe("packaged startup window lifecycle proof", () => {
  it("invalidates the production proof markers for hide and close events", () => {
    const window = new EventEmitter();
    const writeFailureMarker = vi.fn();
    attachPackagedStartupWindowLifecycleProof({
      window,
      enabled: true,
      writeFailureMarker,
    });

    window.emit("hide");
    window.emit("closed");

    expect(writeFailureMarker.mock.calls).toEqual([
      ["packaged main window hidden"],
      ["packaged main window closed"],
    ]);
  });

  it("does not observe ordinary user window lifecycle events", () => {
    const window = new EventEmitter();
    const writeFailureMarker = vi.fn();
    attachPackagedStartupWindowLifecycleProof({
      window,
      enabled: false,
      writeFailureMarker,
    });

    window.emit("hide");
    window.emit("closed");

    expect(writeFailureMarker).not.toHaveBeenCalled();
  });
});
