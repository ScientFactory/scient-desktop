import type { PullRequestActivity, PullRequestCheck, PullRequestComment } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  checkStatus,
  pullRequestCheckPriority,
  pullRequestChecksStatus,
  pullRequestChecksSummary,
  pullRequestReviewSummary,
} from "./pullRequestStatus";

const author = { login: "julius", name: null, avatarUrl: null };
function review(state: string, at: string): PullRequestComment {
  return {
    id: `${state}:${at}`,
    kind: "review",
    author,
    body: "",
    createdAt: at,
    url: null,
    path: null,
    reviewState: state,
  };
}
function activity(
  comments: readonly PullRequestComment[],
): Pick<PullRequestActivity, "comments" | "commits"> {
  return { comments, commits: [] };
}
function check(
  status: PullRequestCheck["status"],
  outcome?: PullRequestCheck["outcome"],
): PullRequestCheck {
  return {
    name: status,
    status,
    ...(outcome === undefined ? {} : { outcome }),
    url: null,
    description: null,
  };
}

describe("mobile overview review status", () => {
  it("uses each reviewer's latest verdict even when history arrives out of order", () => {
    const result = pullRequestReviewSummary(
      { reviewers: [] },
      activity([
        review("CHANGES_REQUESTED", "2026-10-10T10:00:00Z"),
        review("APPROVED", "2026-10-10T09:00:00Z"),
      ]),
    );
    expect(result.title).toBe("Changes requested");
    expect(result.reviews).toHaveLength(1);
  });

  it("does not claim a dismissed approval or an approval preceding the latest commit", () => {
    const approved = review("APPROVED", "2026-10-10T09:00:00Z");
    expect(
      pullRequestReviewSummary(
        { reviewers: [] },
        activity([approved, review("DISMISSED", "2026-10-10T10:00:00Z")]),
      ).reviews,
    ).toEqual([]);
    const result = pullRequestReviewSummary(
      { reviewers: [author] },
      {
        comments: [approved],
        commits: [
          { oid: "abc123", messageHeadline: "Update", committedDate: "2026-10-10T10:00:00Z" },
        ],
      },
    );
    expect(result.title).toBe("Awaiting review");
  });

  it("keeps an approval when a later review only comments, and normalizes provider spelling", () => {
    const result = pullRequestReviewSummary(
      { reviewers: [] },
      activity([
        review("approved", "2026-10-10T09:00:00Z"),
        review("COMMENTED", "2026-10-10T10:00:00Z"),
      ]),
    );
    expect(result.title).toBe("Approved by julius");
    expect(result.reviews).toHaveLength(1);
    expect(
      pullRequestReviewSummary(
        { reviewers: [] },
        activity([review("changes-requested", "2026-10-10T11:00:00Z")]),
      ).title,
    ).toBe("Changes requested");
  });
});

describe("mobile overview check status", () => {
  it("prioritizes failed checks while others are running", () => {
    expect(
      pullRequestChecksSummary({ checks: [check("success"), check("pending"), check("failure")] }),
    ).toMatchObject({ title: "1 check failing", count: "1 of 3" });
  });

  it("keeps terminal warnings distinct from passed checks", () => {
    const warning = check("neutral", "warning");
    expect(checkStatus(warning)).toMatchObject({
      label: "Warning",
      icon: "exclamationmark.triangle",
    });
    expect(pullRequestChecksSummary({ checks: [check("success"), warning] })).toMatchObject({
      title: "1 check has warnings",
      count: "1 of 2",
      icon: "exclamationmark.triangle",
    });
    expect(checkStatus(check("neutral")).label).toBe("Neutral");
    expect(checkStatus(check("skipped")).label).toBe("Skipped");
    expect(
      [check("success"), check("neutral"), warning, check("pending")].toSorted(
        (left, right) => pullRequestCheckPriority(left) - pullRequestCheckPriority(right),
      ),
    ).toEqual([warning, check("pending"), check("neutral"), check("success")]);
    expect(pullRequestChecksStatus("warning")).toEqual({
      icon: "exclamationmark.triangle",
      tint: "accent-warning-foreground",
    });
  });

  it("treats warning outcomes as terminal before checking their status", () => {
    for (const status of ["pending", "failure"] as const) {
      const warning = check(status, "warning");
      expect(checkStatus(warning).label).toBe("Warning");
      expect(pullRequestChecksSummary({ checks: [warning] })).toMatchObject({
        title: "1 check has warnings",
        icon: "exclamationmark.triangle",
      });
    }
  });
});
