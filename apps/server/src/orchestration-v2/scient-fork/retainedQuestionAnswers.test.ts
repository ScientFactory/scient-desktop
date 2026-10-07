import { expect, it } from "@effect/vitest";
import { retainQuestionAnswers } from "./retainedQuestionAnswers.ts";
import { questionAnswerActivity } from "./questionAnswer.test-fixtures.ts";

it("selects submitted answers by retained turns, not timestamps or pending/message-mode records", () => {
  const first = questionAnswerActivity("first");
  const result = retainQuestionAnswers(
    [
      first,
      first,
      questionAnswerActivity("later", "later-answer"),
      { ...first, kind: "user-input.requested" },
      { ...first, kind: "user-input.resolved" },
    ],
    new Set(["first"]),
  );
  expect(result.error).toBeNull();
  expect(result.answers.map(({ activity }) => activity.id)).toEqual([first.id]);
});
it("rejects undecodable retained records and ambiguous turn ownership", () => {
  expect(
    retainQuestionAnswers([{ ...questionAnswerActivity("first"), payload: {} }], new Set(["first"]))
      .error,
  ).toContain("decoded");
  expect(retainQuestionAnswers([questionAnswerActivity(null)], new Set(["first"])).error).toContain(
    "boundary",
  );
  expect(retainQuestionAnswers([questionAnswerActivity(null)], new Set()).answers).toEqual([]);
});
