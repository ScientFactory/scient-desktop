import { describe, expect, it } from "vite-plus/test";

import { cursorRuntimeEnvironment } from "./CursorCli.ts";

describe("Cursor CLI lifecycle policy", () => {
  it("marks only Scient-managed runtimes", () => {
    const source = { HOME: "/Users/scientist" };
    expect(cursorRuntimeEnvironment(source, false)).toBe(source);
    const managed = cursorRuntimeEnvironment(source, true);
    expect(managed).toEqual({
      HOME: "/Users/scientist",
      SCIENT_MANAGED_CURSOR_RUNTIME: "1",
    });
    expect(
      cursorRuntimeEnvironment({ ...source, SCIENT_MANAGED_CURSOR_RUNTIME: "1" }, false),
    ).toEqual(source);
  });
});
