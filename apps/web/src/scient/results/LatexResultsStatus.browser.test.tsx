import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { computeEnvironment } from "~/state/compute";
import { LatexResultsStatus } from "./LatexResultsStatus";

const commands = vi.hoisted(() => ({ placements: vi.fn(), other: vi.fn() }));
vi.mock("~/state/compute", async (original) => {
  const actual = await original<typeof import("~/state/compute")>();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...actual,
    computeEnvironment: {
      ...actual.computeEnvironment,
      resultsUpdateFiles: {
        ...actual.computeEnvironment.resultsUpdateFiles,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock("~/state/use-atom-command", async (original) => ({
  ...(await original<typeof import("~/state/use-atom-command")>()),
  useAtomCommand: (command: unknown) =>
    command === computeEnvironment.resultsPlacements ? commands.placements : commands.other,
}));

it("keeps Undo update reachable from the LaTeX status after closing its popover", async () => {
  commands.placements.mockResolvedValue({
    _tag: "Success",
    value: {
      coverage: "placed",
      scripts: [
        {
          summary: {
            revision: "r000000000001",
            scriptPath: "threshold.py",
            language: "Python",
            finishedAt: "2026-11-23T00:00:00Z",
            inputTracking: "observed",
            inputs: [],
            inputsTruncated: false,
            runtime: { executable: null, version: null },
            causes: [],
          },
          files: [
            {
              path: "results/threshold/roc.png",
              state: "current",
              usedByBuild: null,
              differsFromBuild: true,
            },
          ],
          changes: [],
          newer: null,
          updateBlocked: null,
          canUndo: true,
          interrupted: false,
        },
      ],
    },
  });
  await using _screen = await render(
    <LatexResultsStatus
      environmentId={EnvironmentId.make("fixture")}
      cwd="/project"
      rootPath="paper.tex"
      build={null}
    />,
    { router: false },
  );
  const trigger = page.getByRole("button", { name: "Undo available" });
  const undo = page.getByRole("button", { name: "Undo update" });
  await trigger.click();
  await expect.element(undo).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await expect.element(undo).toBeVisible();
});
