// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  parkUnappliedInput,
  readStartupRecovery,
  removeRecovery,
  isRecoveryStored,
} from "./visualRecovery";

describe("unapplied raw source recovery", () => {
  beforeEach(() => localStorage.clear());
  it("offers exact incomplete input for copying after reopening on a different source", () => {
    const raw = "\\unsupported{incomplete\n😀";
    parkUnappliedInput("raw-test", raw, "view-one", null);
    const recovery = readStartupRecovery("raw-test", { source: "outside source" }).recovery;
    expect(recovery).toMatchObject({ source: null, text: raw, parked: true });
  });
  it("keeps the previous durable draft when the replacement cannot be stored", () => {
    const first = parkUnappliedInput("raw-test", "first", "view-one", null);
    const fail = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const next = parkUnappliedInput("raw-test", "latest", "view-one", first);
    fail.mockRestore();
    expect(next).toMatchObject({ parked: false, source: null, text: "latest" });
    expect(isRecoveryStored("raw-test", first)).toBe(true);
    expect(readStartupRecovery("raw-test", { source: "outside" }).recovery?.text).toBe("first");
  });
  it("coalesces one interaction without deleting another view's input", () => {
    const first = parkUnappliedInput("raw-test", "draft", "view-one", null);
    const independent = parkUnappliedInput("raw-test", "draft", "view-two", null);
    const latest = parkUnappliedInput("raw-test", "new draft", "view-one", first);
    expect(isRecoveryStored("raw-test", first)).toBe(false);
    expect(isRecoveryStored("raw-test", independent)).toBe(true);
    expect(isRecoveryStored("raw-test", latest)).toBe(true);
    removeRecovery("raw-test", first);
    expect(isRecoveryStored("raw-test", latest)).toBe(true);
  });
});
