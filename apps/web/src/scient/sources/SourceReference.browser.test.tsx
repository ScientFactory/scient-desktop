import "~/index.css";
import {
  EnvironmentId,
  type ScientProjectCitationStyle,
  type ScientSourceDetailResult,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { randomUUID } from "~/lib/utils";

import { render } from "../../../test/render";
import { SourceReference } from "./SourceReference";

vi.mock("@scientfactory/scient-citations", () => ({
  formatSourceReference: (
    record: { metadata: { title: string } },
    style: string | { xml: string },
  ) => `${typeof style === "string" ? style : style.xml} · ${record.metadata.title}`,
}));

const server = vi.hoisted(() => ({
  read: async (): Promise<ScientProjectCitationStyle> => {
    throw new Error("unset");
  },
}));

vi.mock("./client", () => ({
  readCitationStyles: async () => ({
    current: await server.read(),
    results: [],
    catalogueMessage: null,
  }),
  setCitationStyle: async () => {
    throw new Error("not used");
  },
}));

function setup(read: () => Promise<ScientProjectCitationStyle>) {
  server.read = read;
  return {
    record: {
      projectId: `project-${randomUUID()}`,
      metadata: { title: "Tidal mixing in a synthetic estuary" },
    } as unknown as ScientSourceDetailResult,
    project: {
      environmentId: EnvironmentId.make("environment-reference"),
      root: `/project-${randomUUID()}`,
    },
  };
}

const ready = (title: string): ScientProjectCitationStyle => ({
  _tag: "ready",
  id: title.toLowerCase(),
  title,
  parent: null,
  xml: `${title} style`,
});

it("opens the style list on click and shows the reference in the chosen style", async () => {
  const { record } = setup(async () => ({ _tag: "none" }));
  await using _screen = await render(<SourceReference record={record} />);
  await expect
    .element(page.getByText("vancouver · Tidal mixing in a synthetic estuary"))
    .toBeVisible();

  await page.getByRole("combobox", { name: "Reference style" }).click();
  await page.getByRole("option", { name: "APA 7" }).click();

  await expect.element(page.getByText("apa · Tidal mixing in a synthetic estuary")).toBeVisible();
});

it("names a project style it cannot use and the style it shows instead", async () => {
  const { record, project } = setup(async () => ({
    _tag: "unavailable",
    id: "nature",
    title: "Nature",
    message: "Nature is missing from this project (.scient/citations/styles/nature.csl).",
  }));
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

// regression: review B4-1, a failed style read showed this browser's style with no notice
it("says when the project's style could not be read and which style it shows", async () => {
  const { record, project } = setup(async () => {
    throw new Error("offline");
  });
  await using _screen = await render(<SourceReference record={record} project={project} />);

  await expect
    .element(
      page.getByText(
        "Scient could not read this project's citation style. Showing Vancouver instead.",
      ),
    )
    .toBeVisible();
  await expect
    .element(page.getByText("vancouver · Tidal mixing in a synthetic estuary"))
    .toBeVisible();
});

// regression: review B4-1, an open reference kept the style an agent had replaced
it("shows the style an agent set once the pointer reaches an open reference", async () => {
  const { record, project } = setup(async () => ready("Nature"));
  await using _screen = await render(<SourceReference record={record} project={project} />);
  await expect
    .element(page.getByText("Nature style · Tidal mixing in a synthetic estuary"))
    .toBeVisible();

  server.read = async () => ready("APA");
  await page.getByRole("region", { name: "Reference" }).hover();

  await expect
    .element(page.getByText("APA style · Tidal mixing in a synthetic estuary"))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Citation style: APA" })).toBeVisible();
});
