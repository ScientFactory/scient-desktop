import { describe, expect, it } from "vitest";

import {
  threadArchiveAccessibleLabel,
  threadArchiveActionLabel,
  threadArchiveToastTitle,
} from "./threadArchivePresentation";

describe("thread archive presentation", () => {
  it("keeps leaf copy concise", () => {
    expect(threadArchiveActionLabel(1)).toBe("Archive");
    expect(threadArchiveAccessibleLabel(1)).toBe("Archive thread");
    expect(threadArchiveToastTitle(1)).toBe("Thread archived");
  });

  it("discloses conversation-family scope and count", () => {
    expect(threadArchiveActionLabel(3)).toBe("Archive family (3)");
    expect(threadArchiveAccessibleLabel(3)).toBe("Archive conversation family (3)");
    expect(threadArchiveToastTitle(3)).toBe("3 conversations archived");
  });
});
