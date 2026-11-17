import { describe, expect, it } from "vite-plus/test";

import {
  clearSentFeedback,
  requestFeedback,
  updateFeedbackDraft,
  useFeedbackDraft,
} from "./feedbackStore";

describe("feedback draft", () => {
  it("keeps typed words and email across openings but never an earlier error or attachment", () => {
    requestFeedback({ source: "turn-error", error: { message: "First failure" } });
    updateFeedbackDraft({ message: "half written", email: "ada@uni.example", logs: "log text" });
    requestFeedback({ source: "sidebar" });
    const draft = useFeedbackDraft.getState();
    expect(draft.message).toBe("half written");
    expect(draft.email).toBe("ada@uni.example");
    expect(draft.error).toBeNull();
    expect(draft.logs).toBeNull();
    expect(draft.source).toBe("sidebar");

    clearSentFeedback();
    expect(useFeedbackDraft.getState()).toMatchObject({
      open: false,
      message: "",
      email: "ada@uni.example",
    });
  });
});
