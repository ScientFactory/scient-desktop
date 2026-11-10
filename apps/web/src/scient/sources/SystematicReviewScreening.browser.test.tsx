import { render } from "../../../test/render";
import "../../index.css";

import {
  scientPrismaCounts,
  scientPrismaMermaid,
  type ScientSystematicReview,
} from "@scientfactory/scient-sources";
import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { SystematicReviewScreening } from "./SystematicReviewScreening";

type SourceSummary = ScientSourcesOverviewResult["records"][number];

function source(sourceId: string, title: string): SourceSummary {
  return {
    sourceId,
    revision: 1,
    type: "article",
    title,
    creators: [],
    issuedYear: 2020,
    identifiers: [],
    containerTitle: null,
    url: null,
    externalReferences: [],
    attachments: [],
    importedAt: "2026-11-10T00:00:00.000Z",
  };
}

const review: ScientSystematicReview = {
  formatVersion: 1,
  reviewId: "review_1",
  title: "Review",
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T00:00:00.000Z",
  updatedBy: "user",
  searches: [],
  otherSourceIds: ["first", "second"],
  duplicates: [],
  distinctPairs: [],
  screening: [],
  exclusionReasons: ["Wrong population"],
};

function screening(onDecide: (...args: ReadonlyArray<unknown>) => Promise<unknown>) {
  const records = new Map([
    ["first", source("first", "First record")],
    ["second", source("second", "Second record")],
  ]);
  const prisma = scientPrismaCounts(review, new Set(records.keys()));
  return (
    <SystematicReviewScreening
      detail={{
        review,
        prisma,
        mermaid: scientPrismaMermaid(prisma),
        possibleDuplicates: [],
        screeningSourceIds: ["first", "second"],
      }}
      stage="title-abstract"
      records={records}
      sourceDetails={{}}
      loadSource={async () => undefined}
      pending={false}
      onDecide={onDecide}
      onClear={async () => undefined}
      onOpenSource={() => undefined}
      onRequestName={() => undefined}
    />
  );
}

describe("Systematic review screening", () => {
  it("decides the shown record from the keyboard and skips to the next one", async () => {
    const onDecide = vi.fn(async () => undefined);
    await using screen = await render(screening(onDecide), { router: false });

    await expect.element(screen.getByText("0 of 2 decided")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    await expect.element(screen.getByRole("button", { name: "Second record" })).toBeVisible();
    (screen.getByRole("article", { name: "Record to screen" }).element() as HTMLElement).focus();
    await userEvent.keyboard("i");
    expect(onDecide).toHaveBeenCalledWith("second", "include", undefined);
  });

  it("excludes with a chosen reason", async () => {
    const onDecide = vi.fn(async () => undefined);
    await using screen = await render(screening(onDecide), { router: false });

    await userEvent.click(screen.getByRole("button", { name: "Exclude" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Wrong population" }));
    expect(onDecide).toHaveBeenCalledWith("first", "exclude", "Wrong population");
  });
});
