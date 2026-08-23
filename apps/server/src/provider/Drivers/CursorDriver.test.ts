import { describe, expect, it } from "vite-plus/test";

import { assistedCursorConnectionMethods } from "./CursorDriver.ts";

describe("CursorDriver assisted account boundary", () => {
  it("offers the official browser subscription flow for the default provider", () => {
    expect(assistedCursorConnectionMethods({ apiEndpoint: "" }, {})).toEqual(["cursor_browser"]);
  });

  it("does not misrepresent external credentials or endpoints as managed browser auth", () => {
    expect(assistedCursorConnectionMethods({ apiEndpoint: "https://cursor.example" }, {})).toEqual(
      [],
    );
    expect(
      assistedCursorConnectionMethods({ apiEndpoint: "" }, { CURSOR_API_KEY: "configured" }),
    ).toEqual([]);
    expect(
      assistedCursorConnectionMethods({ apiEndpoint: "" }, { CURSOR_AUTH_TOKEN: "configured" }),
    ).toEqual([]);
  });
});
