import { expect, it } from "@effect/vitest";

import { comparePackageValues } from "./comparePackageValues.ts";

it("uses the recorded value for relative tolerance and keeps strings and large integers exact", () => {
  const expected = '{"nearZero":0,"close":1,"large":9007199254740992,"text":"1","control":123}';
  const actual = '{"text":1,"close":1.01,"large":9007199254740993,"nearZero":5e-13,"control":123}';
  expect(comparePackageValues(expected, actual, { absolute: 1e-12, relative: 1e-3 })).toMatchObject(
    {
      differenceCount: 3,
      maxAbsoluteError: { pointer: "/large", error: 1 },
      maxRelativeError: { pointer: "/close", error: expect.closeTo(0.01, 12) },
      values: expect.arrayContaining([
        {
          pointer: "/large",
          expected: "9007199254740992",
          actual: "9007199254740993",
          absoluteDifference: 1,
          relativeDifference: 1 / 9007199254740992,
        },
      ]),
    },
  );
  const boundary = comparePackageValues('{"n":100.0}', '{"n":110.5}', {
    absolute: 0,
    relative: 0.1,
  });
  expect(boundary.differenceCount).toBe(1);
});
