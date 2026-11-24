import { EnvironmentId, type ComputeResultLastAttempt } from "@t3tools/contracts";
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
      resultsRerun: {
        ...actual.computeEnvironment.resultsRerun,
        permissionAtom: () => allowed,
      },
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

const placedResults = {
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
};

it("keeps Undo update reachable from the LaTeX status after closing its popover", async () => {
  commands.placements.mockResolvedValue(placedResults);
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

it("replaces the transient notebook rerun notice when the journaled attempt arrives", async () => {
  const script = placedResults.value.scripts[0]!;
  const notebook = {
    ...script,
    summary: { ...script.summary, scriptPath: "threshold.ipynb" },
  };
  const withAttempt = (lastAttempt: ComputeResultLastAttempt) => ({
    ...placedResults,
    value: {
      ...placedResults.value,
      scripts: [{ ...notebook, summary: { ...notebook.summary, lastAttempt } }],
    },
  });
  const next = Promise.withResolvers<ReturnType<typeof withAttempt>>();
  commands.placements
    .mockReset()
    .mockResolvedValue(
      withAttempt({ status: "cancelled", finishedAt: "2026-11-23T01:00:00Z", message: null }),
    );
  const transient = "A notebook cell failed. Open Compute history for its error.";
  commands.other.mockReset().mockImplementation(async () => {
    commands.placements.mockReturnValue(next.promise);
    return { _tag: "Success", value: { _tag: "failed", message: transient } };
  });

  // This status popover does not navigate.
  await using _screen = await render(
    <LatexResultsStatus
      environmentId={EnvironmentId.make("fixture")}
      cwd="/project"
      rootPath="paper.tex"
      build={null}
    />,
    { router: false },
  );
  await page.getByRole("button", { name: "Undo available" }).click();
  await expect.element(page.getByText("Last run stopped", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Re-run threshold.ipynb" }).click();
  await expect.element(page.getByText(transient)).toBeVisible();

  next.resolve(
    withAttempt({ status: "failed", finishedAt: "2026-11-23T02:00:00Z", message: null }),
  );
  await expect.element(page.getByRole("button", { name: "View output" })).toBeVisible();
  await expect.element(page.getByText("Last run failed", { exact: true })).toBeVisible();
  await expect.element(page.getByText(transient)).not.toBeInTheDocument();
});
