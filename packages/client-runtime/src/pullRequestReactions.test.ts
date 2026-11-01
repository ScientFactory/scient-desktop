import type { PullRequestReaction, PullRequestReactionContent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyPendingPullRequestReactions,
  PULL_REQUEST_REACTION_ORDER,
  pullRequestReactionEmoji,
  pullRequestReactionName,
} from "./pullRequestReactions.ts";

function reaction(overrides: Partial<PullRequestReaction> = {}): PullRequestReaction {
  return {
    content: "heart",
    count: 1,
    actors: ["octocat"],
    viewerHasReacted: false,
    ...overrides,
  };
}

describe("reaction presentation", () => {
  it("names and draws all eight, in GitHub's picker order", () => {
    expect(
      PULL_REQUEST_REACTION_ORDER.map((content) => [
        content,
        pullRequestReactionEmoji(content),
        pullRequestReactionName(content),
      ]),
    ).toEqual([
      ["thumbs-up", "👍", "thumbs up"],
      ["thumbs-down", "👎", "thumbs down"],
      ["laugh", "😄", "laugh"],
      ["hooray", "🎉", "hooray"],
      ["confused", "😕", "confused"],
      ["heart", "❤️", "heart"],
      ["rocket", "🚀", "rocket"],
      ["eyes", "👀", "eyes"],
    ]);
  });
});

describe("pending reactions", () => {
  const pending = (
    entries: ReadonlyArray<readonly [PullRequestReactionContent, boolean]>,
  ): ReadonlyMap<PullRequestReactionContent, boolean> => new Map(entries);

  it("adds a reaction nobody had yet, in picker order", () => {
    const applied = applyPendingPullRequestReactions(
      [reaction({ content: "rocket", count: 2, actors: ["a", "b"] })],
      pending([["thumbs-up", true]]),
    );
    expect(applied).toEqual([
      { content: "thumbs-up", count: 1, actors: [], viewerHasReacted: true },
      { content: "rocket", count: 2, actors: ["a", "b"], viewerHasReacted: false },
    ]);
  });

  it("joins and leaves an existing reaction, and drops the pill nobody is left on", () => {
    expect(
      applyPendingPullRequestReactions(
        [reaction({ count: 2, actors: ["a", "b"] })],
        pending([["heart", true]]),
      ),
    ).toEqual([{ content: "heart", count: 3, actors: ["a", "b"], viewerHasReacted: true }]);
    expect(
      applyPendingPullRequestReactions(
        [reaction({ count: 2, actors: ["a", "b"], viewerHasReacted: true })],
        pending([["heart", false]]),
      ),
    ).toEqual([{ content: "heart", count: 1, actors: ["a", "b"], viewerHasReacted: false }]);
    expect(
      applyPendingPullRequestReactions(
        [reaction({ count: 1, viewerHasReacted: true })],
        pending([["heart", false]]),
      ),
    ).toEqual([]);
  });

  it("ignores a pending state the host has already caught up with", () => {
    const reactions = [reaction({ count: 3, viewerHasReacted: true })];
    expect(applyPendingPullRequestReactions(reactions, pending([["heart", true]]))).toEqual(
      reactions,
    );
    expect(applyPendingPullRequestReactions([], pending([["heart", false]]))).toEqual([]);
  });
});
