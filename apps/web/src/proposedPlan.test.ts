import { describe, expect, it } from "vite-plus/test";

import { resolvePlanFollowUpSubmission } from "./proposedPlan";

describe("resolvePlanFollowUpSubmission", () => {
  it.each(["", "Consider this "])(
    "keeps context-bearing feedback in plan mode with prose %j",
    (prose) => {
      const draftText = `${prose}[PR #42](t3-context://v1/review-comment/pr-42)`;
      expect(resolvePlanFollowUpSubmission({ draftText, planMarkdown: "# Plan" })).toEqual({
        text: draftText,
        interactionMode: "plan",
        selectedScientSkillNames: [],
      });
    },
  );
  it("switches to default mode when implementing the ready plan without extra text", () => {
    expect(
      resolvePlanFollowUpSubmission({
        draftText: "   ",
        planMarkdown: "## Ship it\n\n- use $contextskill\n",
      }),
    ).toEqual({
      text: "PLEASE IMPLEMENT THIS PLAN:\n## Ship it\n\n- use $contextskill",
      interactionMode: "default",
      selectedScientSkillNames: [],
    });
  });

  it("stays in plan mode when the user adds a follow-up prompt", () => {
    expect(
      resolvePlanFollowUpSubmission({
        draftText: "$requested refine step 2 first",
        planMarkdown: "## Ship it\n\n- step 1\n",
      }),
    ).toEqual({
      text: "$requested refine step 2 first",
      interactionMode: "plan",
      selectedScientSkillNames: ["requested"],
    });
  });
});
