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
const NO_FILTERS: PullRequestListFilters = {};
const LABEL_OPTIONS = [
  ...Array.from({ length: 11 }, (_, index) => `label-${index}`),
  "size:S",
  "size:XS",
].map((name) => ({ name, color: null, count: 0 }));

function Fixture({ initial = NO_FILTERS }: { readonly initial?: PullRequestListFilters }) {
  const [filters, setFilters] = useState(initial);
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
  await using screen = await render(
    <Fixture initial={{ labels: labels.map((label) => [label]) }} />,
  );
  await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: /^Labels/ }));
  const extra = screen.getByRole("menuitemcheckbox", { name: "label-10" });
  await expect.element(extra).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "label-0" }));
  await expect.element(extra).not.toHaveAttribute("aria-disabled", "true");
  await userEvent.click(extra);
  expect(harness.filters?.labels?.flat()).toEqual([...labels.slice(1), "label-10"]);
});

it("counts label groups and keeps an OR group's alternatives through each edit", async () => {
  setup();
  const singletons = Array.from({ length: 8 }, (_, index) => [`label-${index}`]);
  // One OR pair and eight single labels: nine groups holding ten names.
  await using screen = await render(
    <Fixture initial={{ labels: [["size:S", "size:XS"], ...singletons] }} />,
  );
  await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: /^Labels/ }));
  const tenth = screen.getByRole("menuitemcheckbox", { name: "label-8" });
  const extra = screen.getByRole("menuitemcheckbox", { name: "label-9" });
  await expect.element(tenth).not.toHaveAttribute("aria-disabled", "true");
  await userEvent.click(tenth);
  expect(harness.filters?.labels).toEqual([["size:S", "size:XS"], ...singletons, ["label-8"]]);
  await expect.element(extra).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "size:XS" }));
  expect(harness.filters?.labels).toEqual([["size:S"], ...singletons, ["label-8"]]);
  await expect.element(extra).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "size:S" }));
  await expect.element(extra).not.toHaveAttribute("aria-disabled", "true");
  await userEvent.click(extra);
  expect(harness.filters?.labels).toEqual([...singletons, ["label-8"], ["label-9"]]);
});
