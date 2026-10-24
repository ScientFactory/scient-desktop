import { EnvironmentId } from "@t3tools/contracts";
import type {
  PullRequestActor,
  PullRequestLabel,
  PullRequestListFilters,
} from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const harness = vi.hoisted(() => ({
  hosted: {
    labels: [] as PullRequestLabel[],
    authors: [] as PullRequestActor[],
    truncated: false,
    error: null as string | null,
    isPending: false,
  },
  filters: null as PullRequestListFilters | null,
}));
vi.mock("~/state/pullRequests", () => ({ usePullRequestFilterOptions: () => harness.hosted }));
// The debounce is covered by its owner; these cases exercise settled picker results and admission.
vi.mock("~/state/queries", () => ({ useDebouncedValue: (value: string) => value }));

import { PullRequestFiltersMenu } from "./PullRequestListFilters";

function setup() {
  harness.hosted = { labels: [], authors: [], truncated: false, error: null, isPending: false };
  harness.filters = null;
}
const EMPTY_LABELS: readonly string[] = [];
const LABEL_OPTIONS = Array.from({ length: 11 }, (_, index) => ({
  name: `label-${index}`,
  color: null,
  count: 0,
}));

function Fixture({ labels = EMPTY_LABELS }: { readonly labels?: readonly string[] }) {
  const [filters, setFilters] = useState<PullRequestListFilters>(() =>
    labels.length ? { labels: labels.map((label) => [label]) } : {},
  );
  return (
    <PullRequestFiltersMenu
      state="open"
      stateOptions={[]}
      onState={() => {}}
      involvement="all"
      involvementOptions={[]}
      onInvolvement={() => {}}
      filters={filters}
      onFilters={(next) => {
        harness.filters = next;
        setFilters(next);
      }}
      labelOptions={LABEL_OPTIONS}
      optionScope={[{ environmentId: EnvironmentId.make("picker-fixture"), input: {} }]}
      host={undefined}
      hostOptions={[]}
      onHost={() => {}}
      server={undefined}
      serverOptions={[]}
      onServer={() => {}}
      projects={[]}
      projectId={undefined}
      projectEnvironmentId={undefined}
      unavailable={new Map()}
      onProject={() => {}}
    />
  );
}

it("keeps healthy hosted choices selectable while exposing an incomplete search", async () => {
  setup();
  harness.hosted.labels = [{ name: "release", color: null }];
  harness.hosted.error = "One environment could not be searched";
  await using screen = await render(<Fixture />);
  await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: /^Labels/ }));
  const healthy = screen.getByRole("menuitemcheckbox", { name: "release" });
  await expect.element(healthy).toBeVisible();
  await expect.element(screen.getByRole("status")).toBeVisible();
  await userEvent.click(healthy);
  expect(harness.filters?.labels).toEqual([["release"]]);
});

it("keeps the displayed search within the shared hundred-character request bound", async () => {
  setup();
  await using screen = await render(<Fixture />);
  await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: /^Labels/ }));
  const search = screen.getByLabelText("Search labels");
  await userEvent.type(search, "x".repeat(101));
  await expect.element(search).toHaveValue("x".repeat(100));
});

it("admits a new label only after one of ten selections is removed", async () => {
  setup();
  const labels = Array.from({ length: 10 }, (_, index) => `label-${index}`);
  await using screen = await render(<Fixture labels={labels} />);
  await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: /^Labels/ }));
  const extra = screen.getByRole("menuitemcheckbox", { name: "label-10" });
  await expect.element(extra).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "label-0" }));
  await expect.element(extra).not.toHaveAttribute("aria-disabled", "true");
  await userEvent.click(extra);
  expect(harness.filters?.labels?.flat()).toEqual([...labels.slice(1), "label-10"]);
});
