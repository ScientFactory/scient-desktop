import { describe, expect, it } from "vitest";

import { readDockFileExplorerOpen, storeDockFileExplorerOpen } from "./dockFileExplorerPreference";

function createStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe("dock file explorer preference", () => {
  it("defaults to open", () => {
    expect(readDockFileExplorerOpen(createStorage())).toBe(true);
  });

  it("round-trips a closed preference", () => {
    const storage = createStorage();
    storeDockFileExplorerOpen(false, storage);
    expect(readDockFileExplorerOpen(storage)).toBe(false);
  });

  it("treats unrecognized values as the open default", () => {
    expect(readDockFileExplorerOpen(createStorage("maybe"))).toBe(true);
  });
});
