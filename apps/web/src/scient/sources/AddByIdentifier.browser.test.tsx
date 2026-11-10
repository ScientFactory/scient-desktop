import "~/index.css";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AddByIdentifier } from "./AddByIdentifier";

const state = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("./client", () => ({ addScientSourcesByIdentifier: state.add }));

const environmentId = EnvironmentId.make("synthetic");

function setup() {
  state.add.mockReset();
  return {
    onClose: vi.fn(),
    onAdded: vi.fn(),
    onOpenSource: vi.fn(),
  };
}

it("adds a pasted list, reports what was not added and keeps retryable entries", async () => {
  const handlers = setup();
  const results = [
    {
      input: "10.1000/abc.123",
      identifier: { scheme: "doi", value: "10.1000/abc.123" },
      outcome: "imported",
      sourceId: "source_new",
      title: "Measured outcomes",
      verification: "verified",
      message: null,
    },
    {
      input: "PMID 31452104",
      identifier: { scheme: "pmid", value: "31452104" },
      outcome: "duplicate",
      sourceId: "source_old",
      title: "A trial",
      message: "Already in the Library.",
    },
    {
      input: "arXiv:1706.03762",
      identifier: { scheme: "arxiv", value: "1706.03762" },
      outcome: "unavailable",
      sourceId: null,
      title: null,
      message: "arXiv could not be reached, so nothing was added. Try again later.",
    },
  ] as const;
  state.add.mockResolvedValue({ results });
  await using _screen = await render(
    <AddByIdentifier environmentId={environmentId} root="/project" {...handlers} />,
  );

  await page
    .getByRole("textbox", { name: "Identifiers to add" })
    .fill("10.1000/abc.123\nPMID 31452104\narXiv:1706.03762\nnot an identifier");
  await expect.element(page.getByText("3 identifiers, 1 not recognized")).toBeVisible();
  await page.getByRole("button", { name: "Add 3" }).click();

  await expect.element(page.getByText("Added 1 of 3")).toBeVisible();
  expect(state.add).toHaveBeenCalledWith(environmentId, {
    root: "/project",
    entries: ["10.1000/abc.123", "PMID 31452104", "arXiv:1706.03762", "not an identifier"],
  });
  expect(handlers.onAdded).toHaveBeenCalledWith(results);
  expect(handlers.onClose).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("listitem").nth(1))
    .toHaveTextContent("arXiv:1706.03762 · Couldn't reach arXiv. Try again later.");
  await expect
    .element(page.getByRole("textbox", { name: "Identifiers to add" }))
    .toHaveValue("arXiv:1706.03762");

  await page.getByRole("button", { name: "View" }).click();
  expect(handlers.onOpenSource).toHaveBeenCalledWith("source_old");
});

it("closes once every identifier is added", async () => {
  const handlers = setup();
  state.add.mockResolvedValue({
    results: [
      {
        input: "978-0-262-03384-8",
        identifier: { scheme: "isbn", value: "9780262033848" },
        outcome: "imported",
        sourceId: "source_book",
        title: "Introduction to Algorithms",
        verification: "verified",
        message: null,
      },
    ],
  });
  await using _screen = await render(
    <AddByIdentifier environmentId={environmentId} root="/project" {...handlers} />,
  );

  await page.getByRole("textbox", { name: "Identifiers to add" }).fill("978-0-262-03384-8");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await vi.waitFor(() => expect(handlers.onClose).toHaveBeenCalledOnce());
});
