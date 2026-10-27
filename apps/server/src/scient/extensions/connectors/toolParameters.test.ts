import { expect, it } from "@effect/vitest";
import { extractToolParameters } from "./toolParameters.ts";

it("projects only bounded parameter metadata and sanitizes every server string", () => {
  const key = `secret${"n".repeat(250)}`;
  const schema = {
    properties: {
      [key]: {
        type: ["string", "null"],
        description: `secret ${"d".repeat(2500)}`,
        default: "private",
        enum: ["private"],
      },
      ...Object.fromEntries(
        Array.from({ length: 60 }, (_, i) => [`p${i}`, { type: "t".repeat(150) }]),
      ),
    },
    required: [key],
  };
  const parameters = extractToolParameters(schema, (text) =>
    text.replaceAll("secret", "redacted"),
  )!;
  expect(parameters).toHaveLength(50);
  expect(parameters[0]).toEqual({
    name: `redacted${"n".repeat(192)}`,
    type: "string | null",
    required: true,
    description: `redacted ${"d".repeat(1991)}`,
  });
  expect(parameters[1]).toEqual({ name: "p0", type: "t".repeat(100), required: false });
  expect(JSON.stringify(parameters)).not.toContain("private");
  expect(
    extractToolParameters({ properties: { [`${"n".repeat(199)} last`]: {} } }, String)?.[0]?.name,
  ).toBe("n".repeat(199));
});

it("distinguishes absent schema metadata from an empty parameter list and tolerates malformed properties", () => {
  expect(extractToolParameters(undefined, String)).toBeUndefined();
  expect(extractToolParameters({ properties: [] }, String)).toBeUndefined();
  expect(extractToolParameters({ properties: {} }, String)).toEqual([]);
  expect(
    extractToolParameters(
      {
        properties: { " ": {}, query: null, filter: { type: ["string", 3], description: 42 } },
        required: "query",
      },
      (text) => text,
    ),
  ).toEqual([
    { name: "query", required: false },
    { name: "filter", type: "string", required: false },
  ]);
});
