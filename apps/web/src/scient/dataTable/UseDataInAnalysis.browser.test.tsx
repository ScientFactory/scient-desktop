import "../../index.css";

import { EnvironmentId, ThreadId, type ComputeResultsRerunInput } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const { run, project } = vi.hoisted(() => ({
  run: vi.fn(async (_input: { input: ComputeResultsRerunInput }) => ({
    _tag: "Success",
    value: { _tag: "published" },
  })),
  project: { analysis: "threshold.ipynb" },
}));

vi.mock("~/state/compute", async () => {
  const { Atom } = await import("effect/reactivity");
  const permission = Atom.make(true);
  return {
    computeEnvironment: {
      resultsSetup: { label: "setup" },
      resultsRerun: { label: "rerun", permissionAtom: () => permission },
    },
  };
});

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly label: string }) =>
    command.label === "rerun"
      ? run
      : async () => ({
          _tag: "Success",
          value: {
            inputs: ["views/shortlist.sql"],
            parameters: [{ name: "threshold", value: "0.5", source: "override" }],
            suggestedInputs: [],
          },
        }),
}));

vi.mock("~/components/files/ProjectFilePicker", () => ({
  ProjectFilePickerForTarget: (props: { readonly onSelectFile: (path: string) => void }) => (
    <button type="button" onClick={() => props.onSelectFile(project.analysis)}>
      {project.analysis}
    </button>
  ),
}));

import { ResultRunSetup } from "../results/ResultRunSetup";
import { notebookRunDraftKey, useNotebookRunDrafts } from "../notebook/notebookRunDrafts";
import { UseDataInAnalysis } from "./UseDataInAnalysis";

it.each([
  ["data/predictions.csv", "threshold.py", undefined, undefined],
  ["data/predictions.parquet", "threshold.ipynb", { threshold: "0.7" }, undefined],
  ["views/high_risk.sql", "threshold.ipynb", { threshold: "0.7" }, [] as string[]],
  ["data/predictions.csv", "threshold.ipynb", undefined, undefined],
])(
  "declares %s for the selected saved analysis and keeps its existing inputs",
  async (path, analysis, pending, inputs) => {
    run.mockClear();
    useNotebookRunDrafts.setState({ drafts: {} });
    project.analysis = analysis;
    const environmentId = EnvironmentId.make("environment");
    if (pending !== undefined || inputs !== undefined) {
      useNotebookRunDrafts
        .getState()
        .update(notebookRunDraftKey(environmentId, "/project", analysis), {
          ...(pending === undefined ? {} : { parameters: pending }),
          ...(inputs === undefined ? {} : { inputs }),
        });
    }
    await using screen = await render(
      <UseDataInAnalysis
        environmentId={environmentId}
        threadId={ThreadId.make("thread")}
        file={{ cwd: "/project", path, onOpenPath: () => undefined }}
        sheet={0}
      />,
      { router: false },
    );
    await screen.getByRole("button", { name: "Use in analysis…" }).click();
    await page.getByRole("button", { name: analysis }).click();
    await expect.element(page.getByRole("button", { name: "Copy code" })).toBeEnabled();
    const button =
      analysis.endsWith(".ipynb") && pending === undefined
        ? "Run with input and saved values"
        : "Run fresh with input";
    await page.getByRole("button", { name: button }).click();
    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        environmentId,
        input: {
          cwd: "/project",
          scriptPath: analysis,
          inputs: [...(inputs ?? ["views/shortlist.sql"]), path],
          ...(pending === undefined ? {} : { parameters: pending }),
        },
      }),
    );
  },
);

it("lets a run omit every previously declared input", async () => {
  const onRun = vi.fn();
  await using _screen = await render(
    <ResultRunSetup
      environmentId={EnvironmentId.make("environment")}
      cwd="/project"
      scriptPath="threshold.ipynb"
      onRun={onRun}
      onCancel={() => undefined}
    />,
    { router: false },
  );
  const setup = page.getByRole("dialog", { name: "Run setup" });
  await setup.getByRole("button", { name: "Add file…" }).click();
  const picker = page.getByRole("dialog", { name: "Add a declared input" });
  await picker.getByRole("button", { name: "threshold.ipynb", exact: true }).click();
  await setup.getByRole("button", { name: "Remove input threshold.ipynb" }).click();
  await setup.getByRole("button", { name: "Remove input views/shortlist.sql" }).click();
  await setup.getByRole("button", { name: "Run fresh" }).click();
  expect(onRun).toHaveBeenCalledWith({ parameters: { threshold: "0.5" }, inputs: [] });
});
