import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  PullRequestFilterOptions,
  PullRequestFilterOptionsInput,
  setPullRequestFilterLabel,
} from "./pullRequest.ts";

describe("PullRequestFilterOptions", () => {
  it("round-trips hosted labels and authors through the RPC JSON codec", () => {
    const options: typeof PullRequestFilterOptions.Type = {
      labels: [{ name: "bug", color: "d73a4a" }],
      authors: [
        {
          login: "octocat",
          name: "Octocat",
          avatarUrl: "https://avatars.example/octocat.png",
        },
      ],
      truncated: true,
    };
    const codec = Schema.toCodecJson(PullRequestFilterOptions);

    expect(Schema.decodeSync(codec)(Schema.encodeUnknownSync(codec)(options))).toStrictEqual(
      options,
    );
  });

  it("bounds option searches to 100 project IDs and 100 query characters", () => {
    const decode = Schema.decodeUnknownSync(PullRequestFilterOptionsInput);

    expect(() =>
      decode({
        kind: "labels",
        projectIds: Array.from({ length: 101 }, (_, index) => `project-${index}`),
      }),
    ).toThrow();
    expect(() =>
      decode({
        kind: "authors",
        query: "x".repeat(101),
      }),
    ).toThrow();
  });
});

describe("setPullRequestFilterLabel", () => {
  // regression: 4d14e222e7 fix(upstream): preserve grouped filters and warning compatibility
  // Frozen, so an edit that wrote into its input would throw.
  const singletons = Array.from({ length: 8 }, (_, index) => Object.freeze([`label-${index}`]));
  // One OR pair and eight single names: nine groups holding ten names.
  const nine = Object.freeze([Object.freeze(["size:S", "size:XS"]), ...singletons]);

  it("admits a tenth group by counting groups, not names, and refuses an eleventh", () => {
    const ten = setPullRequestFilterLabel(nine, "label-8", true);
    expect(ten).toEqual([["size:S", "size:XS"], ...singletons, ["label-8"]]);
    for (const [index, group] of nine.entries()) expect(ten?.[index]).toBe(group);
    expect(setPullRequestFilterLabel(ten, "label-9", true)).toBe(ten);
  });

  it("adds nothing for a name any group already holds, in any case", () => {
    expect(setPullRequestFilterLabel(nine, "SIZE:xs", true)).toBe(nine);
    expect(setPullRequestFilterLabel(nine, "Label-3", true)).toBe(nine);
  });

  it("narrows an OR group in place without splitting it or touching other groups", () => {
    const narrowed = setPullRequestFilterLabel(nine, "Size:XS", false);
    expect(narrowed).toEqual([["size:S"], ...singletons]);
    for (const [index, group] of singletons.entries()) expect(narrowed?.[index + 1]).toBe(group);
  });

  it("drops a group only with its last name, which frees room for another group", () => {
    const narrowed = setPullRequestFilterLabel(
      setPullRequestFilterLabel(nine, "label-8", true),
      "size:XS",
      false,
    );
    expect(narrowed).toHaveLength(10);
    expect(setPullRequestFilterLabel(narrowed, "label-9", true)).toBe(narrowed);
    const freed = setPullRequestFilterLabel(narrowed, "size:S", false);
    expect(freed).toEqual([...singletons, ["label-8"]]);
    expect(setPullRequestFilterLabel(freed, "label-9", true)).toEqual([
      ...singletons,
      ["label-8"],
      ["label-9"],
    ]);
  });

  it("clears the filter with its last label and returns the input for no-op edits", () => {
    expect(setPullRequestFilterLabel([["bug"]], "BUG", false)).toBeUndefined();
    expect(setPullRequestFilterLabel(undefined, "bug", true)).toEqual([["bug"]]);
    expect(setPullRequestFilterLabel(nine, "missing", false)).toBe(nine);
  });
});
