import "~/index.css";
import { EnvironmentId, type ScientSourceDetailResult } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { randomUUID } from "~/lib/utils";

import { render } from "../../../test/render";
import { SourceReference } from "./SourceReference";

vi.mock("@scientfactory/scient-citations", () => ({
  formatSourceReference: (record: { metadata: { title: string } }, style: string | object) =>
    `${typeof style === "string" ? style : "project style"} · ${record.metadata.title}`,
}));

vi.mock("./client", () => ({
  readCitationStyles: async () => ({
    current: {
      _tag: "unavailable",
      id: "nature",
      title: "Nature",
      message: "Nature is missing from this project (.scient/citations/styles/nature.csl).",
    },
    results: [],
    catalogueMessage: null,
  }),
  setCitationStyle: async () => {
    throw new Error("not used");
  },
}));

it("opens the style list on click and shows the reference in the chosen style", async () => {
  const record = {
    projectId: `project-${randomUUID()}`,
    metadata: { title: "Tidal mixing in a synthetic estuary" },
  } as unknown as ScientSourceDetailResult;
  await using _screen = await render(<SourceReference record={record} />);
  await expect
    .element(page.getByText("vancouver · Tidal mixing in a synthetic estuary"))
    .toBeVisible();

  await page.getByRole("combobox", { name: "Reference style" }).click();
  await page.getByRole("option", { name: "APA 7" }).click();

  await expect.element(page.getByText("apa · Tidal mixing in a synthetic estuary")).toBeVisible();
});

it("names a project style it cannot use and the style it shows instead", async () => {
  const record = {
    projectId: `project-${randomUUID()}`,
    metadata: { title: "Tidal mixing in a synthetic estuary" },
  } as unknown as ScientSourceDetailResult;
  const project = { environmentId: EnvironmentId.make("environment-reference"), root: "/project" };
  await using _screen = await render(<SourceReference record={record} project={project} />);

  await expect
    .element(
      page.getByText(
        "Nature is missing from this project (.scient/citations/styles/nature.csl). Showing Vancouver instead.",
      ),
    )
    .toBeVisible();
  await expect
    .element(page.getByText("vancouver · Tidal mixing in a synthetic estuary"))
    .toBeVisible();
});
