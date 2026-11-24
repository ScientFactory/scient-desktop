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

it("decides tolerance exactly, at any scale", () => {
  const differs = (expected: string, actual: string, absolute: number, relative: number) =>
    comparePackageValues(`{"n":${expected}}`, `{"n":${actual}}`, { absolute, relative })
      .differenceCount === 1;
  // Two decimals one double cannot tell apart.
  expect(differs("9007199254740992.0", "9007199254740993.0", 0.5, 0)).toBe(true);
  // A 100% change far below the smallest double.
  expect(differs("1e-1001", "2e-1001", 0, 1e-7)).toBe(true);
  // Past the tolerance by a digit a thousand places down.
  expect(differs("1.0", `1.5${"0".repeat(1000)}1`, 0.5, 0)).toBe(true);
  // Within a relative tolerance above the largest double.
  expect(differs("1e310", "1.0000000005e310", 0, 1e-9)).toBe(false);
  expect(differs("0.3", "0.35", 0.1, 0)).toBe(false);
  // Far below the absolute tolerance, at a scale no alignment reaches.
  expect(differs("1e-12000", "2e-12000", 1e-12, 0)).toBe(false);
  expect(differs("1e-12000", "9e-13", 1e-12, 0)).toBe(false);
  // Exponents past what a double counts exactly cannot be shown equal.
  expect(differs("1e9007199254740992", "1e9007199254740993", 0, 0)).toBe(true);
  expect(
    comparePackageValues('{"n":4e-324}', '{"n":5e-324}', { absolute: 0, relative: 0 }).values[0],
  ).toMatchObject({ relativeDifference: 0.25 });
  const long = "12345678901234567890123456789012345678901234567890";
  expect(
    comparePackageValues(`{"n":${long}}`, `{"n":${long.slice(0, -1)}1}`, {
      absolute: 0,
      relative: 0,
    }).values[0]?.relativeDifference,
  ).toBeCloseTo(1 / Number(long), 60);
});
