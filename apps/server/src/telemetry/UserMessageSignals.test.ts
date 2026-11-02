import { expect, it } from "@effect/vitest";

import { userMessageSignals } from "./UserMessageSignals.ts";

it("turns a person's message into counts, never text", () => {
  expect(userMessageSignals("no, that's not what I asked. you broke the build again!!!")).toEqual({
    messageChars: 57,
    messageWords: 11,
    yelling: 0,
    profanity: 0,
    anguish: 1,
    negation: 2,
    repetition: 0,
    blame: 1,
  });
  expect(userMessageSignals("Please plot the survival curves for both cohorts.")).toMatchObject({
    yelling: 0,
    profanity: 0,
    anguish: 0,
    negation: 0,
    repetition: 0,
    blame: 0,
  });
  expect(userMessageSignals(undefined)).toEqual({});
  expect(
    Object.values(userMessageSignals("WHY IS THIS STILL BROKEN")).every(Number.isInteger),
  ).toBe(true);
});
