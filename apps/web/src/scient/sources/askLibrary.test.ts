import { describe, expect, it } from "vite-plus/test";

import { ASK_LIBRARY_PROMPT, askLibraryInsertion } from "./askLibrary";

describe("askLibraryInsertion", () => {
  it("leads the draft with the sentence once and keeps what was typed", () => {
    expect(askLibraryInsertion("")).toBe(`${ASK_LIBRARY_PROMPT} `);
    const typed = "Which papers measure retrieval recall?";
    expect(`${askLibraryInsertion(typed)}${typed}`).toBe(`${ASK_LIBRARY_PROMPT} ${typed}`);
    expect(askLibraryInsertion(`${ASK_LIBRARY_PROMPT} ${typed}`)).toBeNull();
    expect(askLibraryInsertion(` ${ASK_LIBRARY_PROMPT}`)).toBeNull();
  });
});
