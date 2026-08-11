import { describe, expect, it } from "vite-plus/test";

import { nextScientGeneralChatRenameKey } from "./renameState";

describe("Scient General Chat rename state", () => {
  it("clears only the rename operation that actually completed", () => {
    expect(nextScientGeneralChatRenameKey("thread-1", "thread-1")).toBeNull();
    expect(nextScientGeneralChatRenameKey("thread-2", "thread-1")).toBe("thread-2");
  });
});
