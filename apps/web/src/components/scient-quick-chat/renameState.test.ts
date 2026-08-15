import { describe, expect, it } from "vite-plus/test";

import { nextScientQuickChatRenameKey } from "./renameState";

describe("Scient Quick Chat rename state", () => {
  it("clears only the rename operation that actually completed", () => {
    expect(nextScientQuickChatRenameKey("thread-1", "thread-1")).toBeNull();
    expect(nextScientQuickChatRenameKey("thread-2", "thread-1")).toBe("thread-2");
  });
});
