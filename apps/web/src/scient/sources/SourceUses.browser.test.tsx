import "../../index.css";

import type { EnvironmentId, ScientSourceUses } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { ProjectSourceUses } from "./SourceUses";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./client", () => ({ readScientSourceUses: mocks.read }));

const environmentId = "environment-1" as EnvironmentId;

const occurrence = (
  path: string,
  line: number,
  through: ScientSourceUses["occurrences"][number]["through"] = { kind: "project" },
) => ({
  path,
  line,
  column: 4,
  citationKey: "smith2020",
  locator: line === 3 ? "p. 4" : null,
  context: `As [@smith2020] on line ${line}.`,
  contextCitation: { start: 3, end: 15 },
  through,
});

const empty: ScientSourceUses = {
  citationKeys: ["smith2020"],
  occurrences: [],
  listed: [],
  elsewhere: [],
  documents: 4,
  skipped: [],
  complete: true,
};

function setup(...answers: ReadonlyArray<ScientSourceUses | Error>) {
  // A window focus reads again; it gets the last answer.
  mocks.read.mockReset().mockResolvedValue(answers.at(-1));
  for (const answer of answers) {
    if (answer instanceof Error) mocks.read.mockRejectedValueOnce(answer);
    else mocks.read.mockResolvedValueOnce(answer);
  }
  return { onOpenFile: vi.fn() };
}

const section = (onOpenFile: (path: string, line: number) => void) => (
  <ProjectSourceUses
    environmentId={environmentId}
    root="/project"
    sourceId="source_smith"
    version="1"
    onOpenFile={onOpenFile}
  />
);

describe("Used in this project", () => {
  it("lists each citing document and opens a citation at its line", async () => {
    const handlers = setup({
      ...empty,
      occurrences: [
        occurrence("notes/one.md", 3),
        occurrence("notes/one.md", 9),
        occurrence("paper/main.tex", 12, {
          kind: "bibliography",
          path: "paper/refs.bib",
          confirmed: false,
        }),
      ],
      elsewhere: [{ path: "draft.tex", key: "smith2020", bibliography: "old.bib" }],
      // `\nocite` is bibliography membership: shown apart, never counted.
      listed: [{ path: "paper/main.tex", line: 20, citationKey: "smith2020" }],
    });
    await using _screen = await render(section(handlers.onOpenFile), { router: false });

    await expect.element(page.getByText("Cited 3 times in 2 documents.")).toBeVisible();
    await expect
      .element(page.getByText("draft.tex: smith2020 names another work in old.bib"))
      .toBeVisible();
    await expect
      .element(page.getByText("Also listed without a citation (\\nocite) in paper/main.tex."))
      .toBeVisible();

    await userEvent.click(page.getByRole("button", { name: /paper\/main\.tex/u }));
    await expect
      .element(page.getByText("Through paper/refs.bib, not confirmed to be this source"))
      .toBeVisible();

    await userEvent.click(page.getByRole("button", { name: /notes\/one\.md/u }));
    await userEvent.click(page.getByRole("button", { name: /Line 3 · p\. 4/u }));
    expect(handlers.onOpenFile).toHaveBeenCalledWith("notes/one.md", 3);
  });

  it("never says a source is not cited when a document could not be read", async () => {
    const handlers = setup({
      ...empty,
      skipped: [{ path: "big.md", reason: "Larger than 16 MB." }],
      complete: false,
    });
    await using _screen = await render(section(handlers.onOpenFile), { router: false });

    await expect
      .element(page.getByText("No citations found in the 4 documents read; 1 could not be read."))
      .toBeVisible();
    await expect.element(page.getByText(/Not cited/u)).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Details" }));
    await expect.element(page.getByText("big.md: Larger than 16 MB.")).toBeVisible();
  });

  it("offers Retry after a failed reading", async () => {
    const handlers = setup(new Error("offline"), empty);
    await using _screen = await render(section(handlers.onOpenFile), { router: false });

    await userEvent.click(page.getByRole("button", { name: "Retry" }));
    await expect
      .element(page.getByText("Not cited in this project's documents yet."))
      .toBeVisible();
  });

  it("shows the newest reading when an earlier one answers last", async () => {
    const first = Promise.withResolvers<ScientSourceUses>();
    const second = Promise.withResolvers<ScientSourceUses>();
    mocks.read.mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await using _screen = await render(section(vi.fn()), { router: false });
    await expect.element(page.getByText("Looking for citations…")).toBeVisible();

    // Coming back to the window reads again while the first reading is still out.
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    second.resolve({
      ...empty,
      skipped: [{ path: "big.md", reason: "Larger than 16 MB." }],
      complete: false,
    });
    const newer = "No citations found in the 4 documents read; 1 could not be read.";
    await expect.element(page.getByText(newer)).toBeVisible();

    // The earlier reading answers, and every update it makes is rendered before the check.
    await act(async () => {
      first.resolve(empty);
      await first.promise;
      for (let tick = 0; tick < 4; tick++) await Promise.resolve();
    });
    await expect.element(page.getByText(newer)).toBeVisible();
    await expect.element(page.getByText(/Not cited/u)).not.toBeInTheDocument();
  });
});
