import { render } from "../../../test/render";
import "../../index.css";

import type { EnvironmentId } from "@t3tools/contracts";
import { useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { SourceTrashPopover } from "./SourceTrash";

const mocks = vi.hoisted(() => ({ read: vi.fn(), restore: vi.fn(), remove: vi.fn() }));
vi.mock("./client", () => ({
  readScientSourceTrash: mocks.read,
  restoreScientSource: mocks.restore,
  deleteScientSourcesPermanently: mocks.remove,
}));
vi.mock("./sourcesCommands", () => ({ useCanChangeLibrary: () => true }));

const entry = {
  sourceId: "paper",
  revision: 2,
  type: "article" as const,
  title: "Existing study",
  creators: [],
  issuedYear: 2024,
  removedAt: "2026-11-20T10:00:00.000Z",
  removedBy: "user" as const,
};

function Harness(props: { readonly onChanged: () => Promise<unknown> }) {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} type="button">
        Trash
      </button>
      <SourceTrashPopover
        environmentId={"environment-1" as EnvironmentId}
        root="/project"
        open
        anchor={anchor}
        onOpenChange={() => undefined}
        onChanged={props.onChanged}
      />
    </>
  );
}

it("reports a restore from its own answer and reads the Trash again when the Library read fails", async () => {
  mocks.read
    .mockReset()
    .mockResolvedValueOnce({ entries: [entry], issues: [] })
    .mockResolvedValue({ entries: [], issues: [] });
  mocks.restore.mockReset().mockResolvedValue({ outcome: "restored" });
  const onChanged = vi.fn(async () => {
    throw new Error("The Library could not be read.");
  });
  await using _screen = await render(<Harness onChanged={onChanged} />, { router: false });

  await userEvent.click(page.getByRole("button", { name: "Restore" }));
  await expect.element(page.getByText("The trash is empty.")).toBeVisible();
  expect(onChanged).toHaveBeenCalledTimes(1);
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
});
