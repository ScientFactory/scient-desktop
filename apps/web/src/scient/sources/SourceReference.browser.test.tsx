import "~/index.css";
import type { ScientSourceDetailResult } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { randomUUID } from "~/lib/utils";

import { render } from "../../../test/render";
import { SourceReference } from "./SourceReference";

vi.mock("@scientfactory/scient-citations", () => ({
  formatSourceReference: (record: { metadata: { title: string } }, style: string) =>
    `${style} · ${record.metadata.title}`,
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
