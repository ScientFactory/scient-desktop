import { render } from "../../../test/render";
import "../../index.css";

import {
  scientPrismaCounts,
  scientPrismaMermaid,
  type ScientSystematicReview,
} from "@scientfactory/scient-sources";
import type { EnvironmentId, ScientSystematicReviewConflictsResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { SystematicReviewsView } from "./SystematicReviews";
import { rememberReviewPlace } from "./useSystematicReviews";

const mocks = vi.hoisted(() => ({
  canChange: true,
  readSystematicReviews: vi.fn(),
  readSystematicReview: vi.fn(),
  readSystematicReviewConflicts: vi.fn(),
  changeSystematicReviewConflict: vi.fn(),
}));

vi.mock("./sourcesCommands", () => ({
  sourcesCommands: { systematicReviewConflict: {} },
  useCanRunSourcesCommand: () => mocks.canChange,
  useCanChangeLibrary: () => mocks.canChange,
}));
vi.mock("./client", () => ({
  readSystematicReviews: mocks.readSystematicReviews,
  readSystematicReview: mocks.readSystematicReview,
  readSystematicReviewConflicts: mocks.readSystematicReviewConflicts,
  changeSystematicReviewConflict: mocks.changeSystematicReviewConflict,
  changeSystematicReview: vi.fn(),
}));

const environmentId = "environment-1" as EnvironmentId;

const review: ScientSystematicReview = {
  formatVersion: 1,
  reviewId: "review_1",
  title: "Sepsis trials",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  updatedBy: "user",
  searches: [],
  otherSourceIds: [],
  duplicates: [],
  distinctPairs: [],
  screening: [],
  exclusionReasons: [],
};
const prisma = scientPrismaCounts(review, new Set());
const detail = {
  review,
  prisma,
  mermaid: scientPrismaMermaid(prisma),
  possibleDuplicates: [],
  screeningSourceIds: [],
};

const versions: ScientSystematicReviewConflictsResult = {
  current: {
    conflictId: null,
    title: "Sepsis trials",
    updatedAt: "2026-11-01T00:00:00.000Z",
    updatedBy: "user",
    searches: 2,
    records: 40,
    decisions: 12,
    lastDecidedAt: "2026-11-01T00:00:00.000Z",
  },
  versions: [
    {
      conflictId: "conflict_a",
      title: "Sepsis trials (laptop copy)",
      updatedAt: "2026-11-05T00:00:00.000Z",
      updatedBy: "agent",
      searches: 3,
      records: 41,
      decisions: 15,
      lastDecidedAt: null,
    },
  ],
  combineReport: null,
};

function setup(canChange: boolean) {
  mocks.canChange = canChange;
  for (const mock of [
    mocks.readSystematicReviews,
    mocks.readSystematicReview,
    mocks.readSystematicReviewConflicts,
    mocks.changeSystematicReviewConflict,
  ]) {
    mock.mockReset();
  }
  mocks.readSystematicReviews.mockResolvedValue({ reviews: [], issues: [] });
  mocks.readSystematicReview
    .mockResolvedValueOnce({ detail, conflictVersions: 1 })
    .mockResolvedValue({ detail });
  mocks.readSystematicReviewConflicts.mockResolvedValue(versions);
  mocks.changeSystematicReviewConflict.mockResolvedValue({ outcome: "resolved" });
  rememberReviewPlace(`${environmentId}\0/project`, { reviewId: "review_1", tab: "records" });
}

function view() {
  return (
    <SystematicReviewsView
      environmentId={environmentId}
      root="/project"
      records={[]}
      organization={{ collections: [], savedSearches: [] }}
      selectedSourceIds={[]}
      sourceDetails={{}}
      loadSource={async () => undefined}
      onOpenSource={() => undefined}
      onBack={() => undefined}
    />
  );
}

const versionsLine = "This review has another version from a copy of this project.";

describe("versions of a review from a copy of the project", () => {
  it("shows both versions and uses the other, then reloads the review", async () => {
    setup(true);
    await using screen = await render(view(), { router: false });

    await userEvent.click(screen.getByRole("button", { name: versionsLine }));
    await expect.element(page.getByText("Sepsis trials (laptop copy)")).toBeVisible();
    await expect.element(page.getByText("No decisions yet")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Use the other" }));

    await vi.waitFor(() =>
      expect(mocks.changeSystematicReviewConflict).toHaveBeenCalledWith(environmentId, {
        root: "/project",
        reviewId: "review_1",
        change: {
          action: "resolve",
          conflictId: "conflict_a",
          pick: "use-other",
          currentUpdatedAt: "2026-11-01T00:00:00.000Z",
        },
      }),
    );
    await expect.element(screen.getByText(versionsLine)).not.toBeInTheDocument();
    expect(mocks.readSystematicReview).toHaveBeenCalledTimes(2);
  });

  it("offers no choice on versions read before the picker was opened again", async () => {
    setup(true);
    await using screen = await render(view(), { router: false });
    await userEvent.click(screen.getByRole("button", { name: versionsLine }));
    await expect.element(page.getByRole("button", { name: "Keep this version" })).toBeEnabled();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByText("Versions of this review")).not.toBeInTheDocument();

    const read = Promise.withResolvers<ScientSystematicReviewConflictsResult>();
    mocks.readSystematicReviewConflicts.mockReturnValueOnce(read.promise);
    await userEvent.click(screen.getByRole("button", { name: versionsLine }));
    await expect.element(page.getByText("Versions of this review")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Keep this version" }))
      .not.toBeInTheDocument();

    read.resolve(versions);
    await expect.element(page.getByRole("button", { name: "Keep this version" })).toBeEnabled();
  });

  it("shows the versions without the choices to a session that cannot change the Library", async () => {
    setup(false);
    await using screen = await render(view(), { router: false });

    await userEvent.click(screen.getByRole("button", { name: versionsLine }));
    await expect.element(page.getByText("Sepsis trials (laptop copy)")).toBeVisible();
    for (const choice of ["Keep this version", "Use the other", "Combine"]) {
      await expect.element(page.getByRole("button", { name: choice, exact: true })).toBeDisabled();
    }
  });
});
