import "~/index.css";

import { RegistryContext } from "@effect/atom-react";
import {
  ComputeLanguageId,
  ComputeResultRevisionId,
  ComputeSessionId,
  EnvironmentId,
  ThreadId,
  type ComputeLanguageRuntimeInspection,
  type NotebookAlternatives,
  type NotebookCellView,
  type NotebookFreshRun,
  type NotebookFreshRunUpdate,
  type NotebookView,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { computeEnvironment } from "~/state/compute";
import ScientNotebookSurface from "./ScientNotebookSurface";
import { useNotebookRunDrafts } from "./notebookRunDrafts";

const { freshStart, freshStop, runtimeQuery } = vi.hoisted(() => ({
  freshStart: vi.fn(),
  freshStop: vi.fn(),
  runtimeQuery: "test-notebook-runtime",
}));

const freshRunAtom = Atom.make(
  AsyncResult.success<NotebookFreshRunUpdate>({
    job: null,
    settledRunId: null,
  }),
);

vi.mock("~/state/compute", async (original) => {
  const actual = await original<typeof import("~/state/compute")>();
  return {
    computeEnvironment: {
      ...actual.computeEnvironment,
      runtimes: () => runtimeQuery,
      notebookFreshRun: () => freshRunAtom,
    },
  };
});

vi.mock("~/state/query", async (original) => ({
  ...(await original<typeof import("~/state/query")>()),
  useEnvironmentQuery: (query: unknown) => ({
    data: query === runtimeQuery ? { languages: [python] } : null,
    isPending: false,
    isSuccess: true,
    error: null,
    refresh: () => undefined,
  }),
}));

vi.mock("~/state/use-atom-command", async (original) => ({
  ...(await original<typeof import("~/state/use-atom-command")>()),
  useAtomCommand: (command: unknown) => {
    if (command === computeEnvironment.notebookFreshStart) return freshStart;
    if (command === computeEnvironment.notebookFreshStop) return freshStop;
    if (command === computeEnvironment.notebookRead)
      return async () => AsyncResult.success(notebook);
    if (command === computeEnvironment.notebookEdit)
      return async () => AsyncResult.success({ revision: "1.1", refused: [] });
    if (command === computeEnvironment.resultsSetup) return async () => AsyncResult.success(setup);
    return async () => AsyncResult.success(null);
  },
}));

const environmentId = EnvironmentId.make("notebook-test");
const threadRef = { environmentId, threadId: ThreadId.make("notebook-thread") };
const home = "# Threshold analysis\nTen synthetic predictions.";
const heading = "Compute and save results for each threshold in this analysis";
const profile = {
  languageId: ComputeLanguageId.make("python"),
  executable: "/managed/python",
  languageVersion: "3.12.13",
  architecture: null,
  displayName: "Python",
  source: "managed",
} as const;
const python: ComputeLanguageRuntimeInspection = {
  descriptor: {
    languageId: profile.languageId,
    displayName: profile.displayName,
    sourceExtensions: [],
    capabilities: [],
  },
  configuredExecutable: null,
  managedRuntime: null,
  toolkits: [],
  runtimes: [
    {
      profile,
      verification: {
        profile,
        readiness: "ready",
        missingRequirements: [],
        message: null,
        packages: [],
      },
      toolkits: [],
    },
  ],
};

const cell = (
  id: string,
  cellType: NotebookCellView["cellType"],
  source: string,
): NotebookCellView => ({
  id,
  cellType,
  source,
  executionCount: null,
  run: null,
  pendingExecution: null,
  outputs: [],
});
const setup = {
  inputs: ["data/predictions.csv"],
  parameters: [{ name: "threshold", value: "0.5", source: "default" }],
  suggestedInputs: [],
} as const;
function savedRun(
  id: string,
  threshold: string,
  count: string,
): NotebookAlternatives["runs"][number] {
  return {
    revision: ComputeResultRevisionId.make(id),
    codeSha256: "f".repeat(64),
    finishedAt: "2026-11-23T14:10:00.000Z",
    parameters: [{ name: "threshold", value: threshold, source: "override" }],
    values: [],
    outputs: [
      {
        name: "confusion.csv",
        preview: {
          _tag: "table",
          rows: [
            ["predicted_positive", "predicted_negative"],
            [count, "2"],
          ],
          partial: false,
        },
      },
      {
        name: `roc-${threshold}.svg`,
        preview: {
          _tag: "figure",
          mediaType: "image/svg+xml",
          data: btoa(
            `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><rect width="300" height="150" fill="white"/><path d="M30 120L90 45L270 25" fill="none" stroke="#2b6cb0"/><text x="30" y="20" fill="black">ROC at threshold ${threshold}</text></svg>`,
          ),
        },
      },
    ],
  };
}
const published = savedRun("r000000000001", "0.5", "4");
const alternate = {
  ...savedRun("r000000000002", "0.7", "3"),
  finishedAt: "2026-11-23T14:12:00.000Z",
};
const notebook: NotebookView = {
  revision: "1.0",
  language: "python",
  cells: [
    cell("intro", "markdown", home),
    {
      ...cell("parameter", "code", "threshold = 0.5"),
      parameterCell: true,
      parameterHints: { threshold: { min: 0.3, max: 0.7, step: 0.1 } },
      savedParameters: { threshold: "0.5" },
    },
    { ...cell("results", "markdown", `## ${heading}`), folded: ["source"] },
    {
      ...cell("compute", "code", "print(threshold)"),
      executionCount: 1,
      outputs: [
        {
          outputType: "stream",
          mediaTypes: [],
          bytes: 4,
          json: JSON.stringify({ output_type: "stream", name: "stdout", text: "0.5\n" }),
        },
      ],
    },
  ],
  alternatives: {
    publishedRevision: published.revision,
    runs: [alternate, published],
    prunedRuns: 0,
  },
};

const screenshots = import.meta.env.VITE_NOTEBOOK_DESIGN_SCREENSHOTS as string | undefined;

it.each(screenshots ? (["light", "dark"] as const) : (["light"] as const))(
  "returns keyboard focus from the outline and previews saved parameter settings in %s",
  async (theme) => {
    freshStart.mockReset().mockResolvedValue(
      AsyncResult.success({
        runId: ComputeSessionId.make("fixture-run"),
        outcome: { _tag: "failed", message: "Test run completed." },
      }),
    );
    useNotebookRunDrafts.setState({ drafts: {} });
    using _permission = vi
      .spyOn(computeEnvironment.notebookFreshStart, "permissionAtom")
      .mockReturnValue(Atom.make(true));
    const root = document.documentElement;
    await using restoration = new AsyncDisposableStack();
    const wasDark = root.classList.contains("dark");
    const viewportSize = { width: innerWidth, height: innerHeight };
    restoration.defer(async () => {
      root.classList.toggle("dark", wasDark);
      await page.viewport(viewportSize.width, viewportSize.height);
    });
    root.classList.toggle("dark", theme === "dark");
    await page.viewport(360, 820);
    await using screen = await render(
      <div className="flex h-dvh w-full bg-background text-foreground">
        <ScientNotebookSurface
          environmentId={environmentId}
          cwd="/project"
          relativePath="threshold.ipynb"
          threadRef={threadRef}
          fileRevision="1.0"
        />
      </div>,
    );

    const outline = screen.getByRole("button", { name: "Notebook outline" });
    const viewport = screen.container.querySelector<HTMLElement>(
      "[data-assistant-citation-viewport]",
    )!;
    await expect.element(screen.getByRole("heading", { name: "Threshold analysis" })).toBeVisible();
    const editorWidth = viewport.clientWidth;
    (outline.element() as HTMLButtonElement).focus();
    await userEvent.keyboard("{Enter}");
    const sheet = page.getByRole("dialog", { name: "Notebook outline" });
    const destination = sheet.getByRole("button", { name: heading });
    await expect.element(destination).toBeVisible();
    expect(viewport.clientWidth).toBe(editorWidth);
    (destination.element() as HTMLButtonElement).focus();
    if (screenshots) {
      await vi.waitFor(() => expect(getComputedStyle(sheet.element()).opacity).toBe("1"));
      await page.screenshot({ path: `${screenshots}/sheet-360-${theme}.png` });
    }
    await userEvent.keyboard("{Enter}");
    await expect.element(sheet).not.toBeInTheDocument();
    await expect.element(screen.getByRole("heading", { name: heading })).toHaveFocus();

    const editorSlider = screen.getByRole("slider", { name: "threshold" });
    (editorSlider.element() as HTMLInputElement).focus();
    await userEvent.keyboard("{End}");
    await expect.element(screen.getByText("Last run used 0.5")).toBeVisible();
    const computeCell = page.elementLocator(
      viewport.querySelector('[data-notebook-cell="compute"]')!,
    );
    await expect.element(computeCell.getByText("0.5", { exact: true })).toBeVisible();
    expect(freshStart).not.toHaveBeenCalled();
    if (screenshots) await page.screenshot({ path: `${screenshots}/editor-360-${theme}.png` });

    await page.viewport(700, 820);
    await expect.element(outline).not.toHaveAttribute("aria-haspopup");
    await outline.click();
    const dock = screen.getByRole("navigation", { name: "Notebook outline" });
    await expect
      .element(dock.getByRole("button", { name: heading }))
      .toHaveAttribute("aria-current", "location");
    if (screenshots) await page.screenshot({ path: `${screenshots}/editor-wide-${theme}.png` });
    await screen.getByRole("button", { name: "Choose Python code to run" }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Run all", exact: true }))
      .toBeEnabled();
    await userEvent.keyboard("{Escape}");
    await screen.getByRole("button", { name: "Run with changes" }).click();
    expect(freshStart).not.toHaveBeenCalled();
    await page.getByRole("alertdialog").getByRole("button", { name: "Run fresh" }).click();
    await vi.waitFor(() =>
      expect(freshStart).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: {
          cwd: "/project",
          scriptPath: "threshold.ipynb",
          inputs: ["data/predictions.csv"],
          parameters: { threshold: "0.7" },
        },
      }),
    );

    await page.viewport(360, 820);
    await screen.getByRole("button", { name: "Reader view" }).click();
    const readerSlider = screen.getByRole("slider", { name: "threshold" });
    const saved = screen.getByRole("status", { name: "Saved run status" });
    await expect.element(saved.getByText("Saved run", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("img", { name: "roc-0.5.svg" })).toBeVisible();
    (readerSlider.element() as HTMLInputElement).focus();
    await userEvent.keyboard("{End}");
    await expect.element(screen.getByRole("row", { name: "3 2" })).toBeVisible();
    await expect.element(screen.getByRole("img", { name: "roc-0.7.svg" })).toBeVisible();
    expect(saved.element().querySelector("time")?.dateTime).toBe(alternate.finishedAt);
    await expect.element(screen.getByRole("img", { name: "roc-0.5.svg" })).not.toBeInTheDocument();
    if (screenshots)
      await page.screenshot({ path: `${screenshots}/reader-saved-360-${theme}.png` });
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(saved).toHaveTextContent("No saved run at these values");
    await expect.element(screen.getByRole("table")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("img", { name: "roc-0.7.svg" })).not.toBeInTheDocument();
    if (screenshots)
      await page.screenshot({ path: `${screenshots}/reader-unsaved-360-${theme}.png` });
    await screen.getByRole("button", { name: "Reset" }).click();
    await expect.element(screen.getByRole("row", { name: "4 2" })).toBeVisible();
    await screen.getByRole("button", { name: "Code", exact: true }).first().click();
    await expect.element(screen.getByText("threshold = 0.5", { exact: true })).toBeVisible();
    expect(freshStart).toHaveBeenCalledTimes(1);
  },
);

it("receives a server-started job while idle and stops that job", async () => {
  const job: NotebookFreshRun = {
    runId: ComputeSessionId.make("reopened-job"),
    parameters: { threshold: "0.7" },
    progress: { phase: "running", cell: 2, total: 4 },
  };
  useNotebookRunDrafts.setState({ drafts: {} });
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  freshStop.mockReset().mockImplementation(async () => {
    const stopped: NotebookFreshRun = {
      ...job,
      outcome: { _tag: "failed", message: "The notebook run was stopped." },
    };
    registry.set(freshRunAtom, AsyncResult.success({ job: stopped, settledRunId: job.runId }));
    return AsyncResult.success(stopped);
  });
  using _permission = vi
    .spyOn(computeEnvironment.notebookFreshStop, "permissionAtom")
    .mockReturnValue(Atom.make(true));
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <ScientNotebookSurface
        environmentId={environmentId}
        cwd="/project"
        relativePath="threshold.ipynb"
        threadRef={threadRef}
        fileRevision="1.0"
      />
    </RegistryContext.Provider>,
  );
  const slider = screen.getByRole("slider", { name: "threshold" });
  await expect.element(slider).toBeEnabled();
  await act(() => registry.set(freshRunAtom, AsyncResult.success({ job, settledRunId: null })));
  await expect.element(slider).toHaveValue("0.7");
  await expect.element(slider).toBeDisabled();
  await expect.element(screen.getByText("Cell 2 of 4", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Stop" }).click();
  await expect.element(screen.getByText("The notebook run was stopped.")).toBeVisible();
  expect(freshStop).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { cwd: "/project", scriptPath: "threshold.ipynb", runId: job.runId },
  });
});

it("lets the author choose sweep values and shows the failed settings", async () => {
  const job: NotebookFreshRun = {
    runId: ComputeSessionId.make("sweep-job"),
    outcome: { _tag: "failed", message: "A cell failed." },
    sweepSummary: {
      total: 2,
      saved: 1,
      failures: [{ index: 0, parameters: { threshold: "0.3" }, message: "A cell failed." }],
    },
  };
  useNotebookRunDrafts.setState({ drafts: {} });
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  freshStart.mockReset().mockResolvedValue(
    AsyncResult.success({
      runId: job.runId,
      progress: { phase: "running", cell: 1, total: 2 },
    } satisfies NotebookFreshRun),
  );
  using _permission = vi
    .spyOn(computeEnvironment.notebookFreshStart, "permissionAtom")
    .mockReturnValue(Atom.make(true));
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <ScientNotebookSurface
        environmentId={environmentId}
        cwd="/project"
        relativePath="threshold.ipynb"
        threadRef={threadRef}
        fileRevision="1.0"
      />
    </RegistryContext.Provider>,
  );
  await screen.getByRole("button", { name: "Choose Python code to run" }).click();
  await page.getByRole("menuitem", { name: "Run for each threshold value" }).click();
  const dialog = page.getByRole("dialog", { name: "Run for each threshold value" });
  await expect.element(dialog.getByRole("button", { name: "Start 5 runs" })).toBeEnabled();
  await dialog.getByRole("textbox", { name: "Values" }).fill("0.3\n0.7");
  expect(freshStart).not.toHaveBeenCalled();
  await dialog.getByRole("button", { name: "Start 2 runs" }).click();
  // Admission resolves before the subscription delivers this job.
  await expect.element(screen.getByText("Cell 1 of 2", { exact: true })).toBeVisible();
  const slider = screen.getByRole("slider", { name: "threshold" });
  await expect.element(slider).toBeDisabled();
  await act(() =>
    registry.set(freshRunAtom, AsyncResult.success({ job, settledRunId: job.runId })),
  );
  await expect.element(slider).toBeEnabled();
  await expect.element(screen.getByText("1 of 2 runs saved", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("threshold = 0.3 · A cell failed.")).toBeVisible();
  expect(freshStart).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      cwd: "/project",
      scriptPath: "threshold.ipynb",
      inputs: ["data/predictions.csv"],
      sweep: [{ threshold: "0.3" }, { threshold: "0.7" }],
    },
  });
});
