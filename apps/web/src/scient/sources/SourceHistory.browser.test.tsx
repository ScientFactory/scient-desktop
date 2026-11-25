import "../../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SourceHistoryDialog } from "./SourceHistory";

const mocks = vi.hoisted(() => ({ revisions: vi.fn() }));
vi.mock("./client", () => ({
  readScientSourceRevisions: mocks.revisions,
  revertScientSource: vi.fn(),
}));
vi.mock("./sourcesCommands", () => ({ useCanChangeLibrary: () => true }));

describe("a source's History", () => {
  it("offers Restore only on versions whose details a restore brings back", async () => {
    const version = (revision: number, changes: ReadonlyArray<string>) => ({
      revision,
      savedAt: `2026-11-25T19:${10 + revision}:00.000Z`,
      savedBy: "user" as const,
      changes,
      current: revision === 6,
    });
    mocks.revisions.mockResolvedValue({
      revisions: [
        version(6, ["title"]),
        version(5, ["note"]),
        version(4, ["attachments"]),
        version(3, ["note", "attachments"]),
        version(2, ["title", "note"]),
        version(1, []),
      ],
    });
    await using _screen = await render(
      <SourceHistoryDialog
        environmentId={EnvironmentId.make("environment_test")}
        root="/project"
        sourceId="source_a"
        revision={6}
        onClose={() => undefined}
        onReverted={() => undefined}
      />,
      { router: false },
    );

    const rows = page.getByRole("listitem");
    await expect.element(rows.nth(5)).toBeVisible();
    const restores = rows.elements().map((row) => row.querySelector("button")?.textContent ?? null);
    // My note and the PDFs stay as they are now, so versions that changed only them offer none.
    expect(restores).toEqual([null, null, null, null, "Restore", "Restore"]);
  });
});
