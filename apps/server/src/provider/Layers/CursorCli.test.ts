import { describe, expect, it } from "vite-plus/test";

import {
  cursorCliArgs,
  cursorRuntimeEnvironment,
  hasExternalCursorAccountConfiguration,
} from "./CursorCli.ts";

describe("Cursor CLI lifecycle policy", () => {
  it("marks only Scient-managed runtimes and disables their in-place updater", () => {
    const source = { HOME: "/Users/scientist" };
    expect(cursorRuntimeEnvironment(source, false)).toBe(source);
    const managed = cursorRuntimeEnvironment(source, true);
    expect(managed).toEqual({
      HOME: "/Users/scientist",
      SCIENT_MANAGED_CURSOR_RUNTIME: "1",
    });
    expect(cursorCliArgs(["about", "--format", "json"], managed)).toEqual([
      "--disable-auto-update",
      "about",
      "--format",
      "json",
    ]);
    expect(cursorCliArgs(["about"], source)).toEqual(["about"]);
    expect(
      cursorRuntimeEnvironment({ ...source, SCIENT_MANAGED_CURSOR_RUNTIME: "1" }, false),
    ).toEqual(source);
  });

  it("preserves advanced external authentication instead of advertising browser ownership", () => {
    expect(hasExternalCursorAccountConfiguration({ apiEndpoint: "" }, {})).toBe(false);
    expect(
      hasExternalCursorAccountConfiguration({ apiEndpoint: "" }, { CURSOR_API_KEY: undefined }),
    ).toBe(false);
    expect(
      hasExternalCursorAccountConfiguration({ apiEndpoint: "https://cursor.example" }, {}),
    ).toBe(true);
    expect(
      hasExternalCursorAccountConfiguration({ apiEndpoint: "" }, { CURSOR_API_KEY: "secret" }),
    ).toBe(true);
    expect(
      hasExternalCursorAccountConfiguration({ apiEndpoint: "" }, { cursor_auth_token: "secret" }),
    ).toBe(true);
  });
});
