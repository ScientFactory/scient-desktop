import type { PullRequestCheck } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  checkStatus,
  pullRequestCheckPriority,
  pullRequestChecksStatus,
  pullRequestChecksSummary,
} from "./pullRequestStatus";

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

describe("mobile overview check warnings", () => {
  // regression: 235eba262b fix(upstream): preserve Stop and composed client semantics
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

  // regression: 087611cf4b fix(upstream): repair review boundaries and completion receipts
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
