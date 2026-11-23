import "../../index.css";

import {
  ComputeResultRevisionId,
  EnvironmentId,
  type ComputeResultSummary,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { computeEnvironment } from "~/state/compute";
import { ScientMarkdownEditorView } from "../markdownEditor/prosemirror/view";
import { ResultPackageMenu, ResultPackagePalette } from "./handoff/resultPackagePalette";
import { MarkdownResults, type MarkdownResultsHandle } from "./MarkdownResults";
import { ResultPicker } from "./ResultPicker";
import { ResultRunEvidence } from "./ResultRunEvidence";

vi.mock("~/hooks/useActiveProjectTarget", () => ({ useActiveProjectTarget: () => null }));
vi.mock("~/assets/assetUrls", async (original) => ({
  ...(await original<typeof import("~/assets/assetUrls")>()),
  useAssetUrlState: () => ({
    _tag: "Success",
    url:
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><path d="M0 200L320 0" stroke="blue"/></svg>',
      ),
  }),
}));

const commands = vi.hoisted(() => ({
  resolve: vi.fn(),
  list: vi.fn(),
  choices: vi.fn(),
  save: vi.fn(),
  attemptOutput: vi.fn(),
  setup: vi.fn(),
  unused: vi.fn(),
}));

vi.mock("~/state/compute", async (original) => {
  const actual = await original<typeof import("~/state/compute")>();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const history = Atom.make(
    AsyncResult.success({
      revisions: [
        {
          revision: "r000000000002",
          finishedAt: "2026-11-23T09:00:00Z",
          parameters: [{ name: "threshold", value: "0.7", source: "override" }],
        },
        {
          revision: "r000000000001",
          finishedAt: "2026-11-23T08:00:00Z",
          parameters: [{ name: "threshold", value: "0.5", source: "override" }],
        },
      ],
    }),
  );
  const snapshot = (revision: string) => ({
    revision,
    scriptPath: "threshold.py",
    language: "Python",
    finishedAt: "2026-11-23T08:00:00Z",
    inputTracking: "observed",
    inputs: [],
    inputsTruncated: false,
    runtime: { executable: null, version: null },
    causes: [],
  });
  const compare = (from: string, to: string, swapped: boolean) =>
    Atom.make(
      AsyncResult.success({
        from: snapshot(from),
        to: snapshot(to),
        codeChanged: false,
        parameters: [],
        inputs: [
          {
            path: "data/predictions.csv",
            change: "same",
            evidence: {
              from: { origin: "observed", changedDuringRun: false },
              to: { origin: "both", changedDuringRun: false },
            },
          },
        ],
        runtime: { changed: false, from: snapshot(from).runtime, to: snapshot(to).runtime },
        environment: [],
        outputs: [
          { name: "confusion.csv", kind: "table", change: "changed" },
          { name: "roc.svg", kind: "figure", change: "changed" },
        ],
        values: [
          {
            output: "metrics.json",
            pointer: "/recall",
            from: swapped ? "0.6" : "0.8",
            to: swapped ? "0.8" : "0.6",
            delta: swapped ? 0.2 : -0.2,
          },
          { output: "metrics.json", pointer: "/n", from: "10", to: "10", delta: 0 },
        ],
        valuesTruncated: false,
      }),
    );
  const comparison = compare("r000000000001", "r000000000002", false);
  const reversed = compare("r000000000002", "r000000000001", true);
  const preview = Atom.make(
    AsyncResult.success({
      _tag: "table",
      rows: [
        ["actual", "predicted_positive", "predicted_negative", "prediction_coverage", "annotation"],
        ["positive", "3", "2", "0.75", "one"],
        ["negative", "1", "4", "0.80", "two"],
      ],
      columns: [
        { name: "actual", type: "text", label: "text" },
        { name: "predicted_positive", type: "integer", label: "int" },
        { name: "predicted_negative", type: "integer", label: "int" },
        { name: "prediction_coverage", type: "number", label: "float" },
        { name: "annotation", type: "text", label: "text" },
      ],
    }),
  );
  const figure = Atom.make(
    AsyncResult.success({
      _tag: "figure",
      path: "/project/roc.svg",
      mediaType: "image/svg+xml",
    }),
  );
  return {
    ...actual,
    computeEnvironment: {
      ...actual.computeEnvironment,
      resultsHistory: () => history,
      resultsCompare: ({ input }: { input: { from: string } }) =>
        input.from === "r000000000001" ? comparison : reversed,
      resultsPreview: ({ input }: { input: { output: string } }) =>
        input.output === "roc.svg" ? figure : preview,
      resultsRerun: { ...actual.computeEnvironment.resultsRerun, permissionAtom: () => allowed },
      resultsExport: { ...actual.computeEnvironment.resultsExport, permissionAtom: () => allowed },
      resultsVerify: { ...actual.computeEnvironment.resultsVerify, permissionAtom: () => allowed },
    },
  };
});

vi.mock("~/state/use-atom-command", async (original) => ({
  ...(await original<typeof import("~/state/use-atom-command")>()),
  useAtomCommand: (command: unknown) =>
    command === computeEnvironment.resultsResolve
      ? commands.resolve
      : command === computeEnvironment.resultsHandoffChoices
        ? commands.choices
        : command === computeEnvironment.resultsExport
          ? commands.save
          : command === computeEnvironment.resultsExportProgress
            ? async () => ({ _tag: "Success", value: null })
            : command === computeEnvironment.resultsList
              ? commands.list
              : command === computeEnvironment.resultsAttemptOutput
                ? commands.attemptOutput
                : command === computeEnvironment.resultsSetup
                  ? commands.setup
                  : commands.unused,
}));

describe("mixed runs in a Markdown paper", () => {
  it("previews and updates one run while preserving the other sensitivity variants", async () => {
    const old = ComputeResultRevisionId.make("r000000000001");
    const middle = ComputeResultRevisionId.make("r000000000002");
    const latest = ComputeResultRevisionId.make("r000000000003");
    const summary = (revision: ComputeResultRevisionId): ComputeResultSummary => ({
      revision,
      scriptPath: "threshold.py",
      language: "Python",
      finishedAt: "2026-11-23T00:00:00Z",
      inputTracking: "observed",
      inputs: [],
      inputsTruncated: false,
      runtime: { executable: null, version: null },
      parameters: [
        {
          name: "threshold",
          value: revision === old ? "0.3" : revision === middle ? "0.5" : "0.7",
          source: "override",
        },
      ],
      causes: [],
    });
    commands.resolve.mockImplementation(
      async ({ input }: { input: { references: { revision: ComputeResultRevisionId }[] } }) => ({
        _tag: "Success",
        value: {
          resolutions: input.references.map(({ revision }) => ({
            _tag: "resolved",
            summary: summary(revision),
            value: revision === latest ? "0.800" : "0.600",
            figure: false,
            newer:
              revision === latest
                ? null
                : { summary: summary(latest), value: "0.800", figure: false },
          })),
        },
      }),
    );
    const source =
      [
        `Recall [0.600](scient-result:${old}/values.json#/recall).`,
        `Precision [0.600](scient-result:${middle}/values.json#/precision).`,
        `Specificity [0.800](scient-result:${latest}/values.json#/specificity).`,
      ].join("\n\n") + "\n";
    const onUserSourceChange = vi.fn();
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "before",
      mode: "write",
      ariaLabel: "Markdown paper",
      onUserSourceChange,
    });
    await using screen = await render(
      <MarkdownResults
        controller={controller}
        environmentId={EnvironmentId.make("fixture")}
        cwd="/project"
        documentPath="paper.md"
        register={() => () => {}}
      />,
      { router: false },
    );
    const host = document.createElement("div");
    screen.container.append(host);
    await act(() => {
      controller.mount(host);
    });
    try {
      const notice = page.getByText("This paper uses results from 3 runs of threshold.py", {
        exact: true,
      });
      await expect.element(notice).toBeVisible();
      expect(notice.elements()).toHaveLength(1);
      await expect.element(page.getByText(/threshold = 0.3/)).toBeVisible();
      await expect.element(page.getByText(/threshold = 0.5/)).toBeVisible();
      await expect.element(page.getByText(/threshold = 0.7/).last()).toBeVisible();
      expect(
        page.getByRole("button", { name: "Update links from this run" }).elements(),
      ).toHaveLength(0);
      await page.getByText("Review changes for this run", { exact: true }).first().click();
      await expect
        .element(page.getByText("/recall · 0.600 → 0.800", { exact: true }))
        .toBeVisible();
      await page.getByRole("button", { name: "Update links from this run" }).click();
      await expect
        .element(page.getByText("This paper uses results from 2 runs of threshold.py"))
        .toBeVisible();
      expect(onUserSourceChange).toHaveBeenCalledOnce();
      expect(onUserSourceChange.mock.calls[0]?.[0]).toBe(
        source.replace(old, latest).replace("Recall [0.600]", "Recall [0.800]"),
      );
      expect(controller.resultReferences().map(({ revision }) => revision)).toEqual([
        latest,
        middle,
        latest,
      ]);
      await page.getByRole("button", { name: "These differ on purpose" }).click();
      await expect
        .element(page.getByText("This paper uses results from 2 runs of threshold.py"))
        .not.toBeInTheDocument();
      expect(
        localStorage.getItem(
          "scient-markdown-intentional-results:" +
            JSON.stringify(["fixture", "/project", "paper.md", "threshold.py", [middle, latest]]),
        ),
      ).toBe("intentional");
      expect(onUserSourceChange).toHaveBeenCalledOnce();
    } finally {
      controller.destroy();
    }
  });

  it.each([false, true])(
    "offers intentional dismissal only for different input bytes (%s)",
    async (differentInputs) => {
      const old = ComputeResultRevisionId.make("r000000000001");
      const latest = ComputeResultRevisionId.make("r000000000002");
      const documentPath = differentInputs ? "changed-inputs.md" : "same-setup.md";
      const storageKey =
        "scient-markdown-intentional-results:" +
        JSON.stringify(["fixture", "/project", documentPath, "threshold.py", [old, latest]]);
      // An older UI could have stored this for two runs with the same setup.
      if (!differentInputs) localStorage.setItem(storageKey, "intentional");
      const summary = (revision: ComputeResultRevisionId): ComputeResultSummary => ({
        revision,
        scriptPath: "threshold.py",
        language: "Python",
        finishedAt: revision === old ? "2026-11-23T08:00:00Z" : "2026-11-23T09:00:00Z",
        inputTracking: "observed",
        inputs: ["data/predictions.csv"],
        inputsTruncated: false,
        inputFingerprint: (differentInputs && revision === latest ? "b" : "a").repeat(64),
        runtime: { executable: null, version: null },
        parameters: [{ name: "threshold", value: "0.5", source: "override" }],
        causes: [],
      });
      commands.resolve.mockImplementation(
        async ({ input }: { input: { references: { revision: ComputeResultRevisionId }[] } }) => ({
          _tag: "Success",
          value: {
            resolutions: input.references.map(({ revision }) => ({
              _tag: "resolved",
              summary: summary(revision),
              value: revision === latest ? "0.800" : "0.600",
              figure: false,
              newer:
                revision === latest
                  ? null
                  : { summary: summary(latest), value: "0.800", figure: false },
            })),
          },
        }),
      );
      const controller = new ScientMarkdownEditorView({
        source: `Recall [0.600](scient-result:${old}/values.json#/recall).\n\nPrecision [0.800](scient-result:${latest}/values.json#/precision).\n`,
        revision: "before",
        mode: "write",
        ariaLabel: "Markdown paper",
        onUserSourceChange: vi.fn(),
      });
      await using screen = await render(
        <MarkdownResults
          controller={controller}
          environmentId={EnvironmentId.make("fixture")}
          cwd="/project"
          documentPath={documentPath}
          register={() => () => {}}
        />,
        { router: false },
      );
      const host = document.createElement("div");
      screen.container.append(host);
      await act(() => controller.mount(host));
      try {
        await expect
          .element(page.getByText("This paper uses results from 2 runs of threshold.py"))
          .toBeVisible();
        const dismiss = page.getByRole("button", { name: "These differ on purpose" });
        if (differentInputs) {
          await expect.element(dismiss).toBeVisible();
        } else {
          await expect.element(dismiss).not.toBeInTheDocument();
          await page.getByText("Review changes for this run").click();
          await expect
            .element(page.getByText("/recall · 0.600 → 0.800", { exact: true }))
            .toBeVisible();
          await page.getByRole("button", { name: "Update links from this run" }).click();
          expect(controller.resultReferences().map(({ revision }) => revision)).toEqual([
            latest,
            latest,
          ]);
        }
      } finally {
        controller.destroy();
        localStorage.removeItem(storageKey);
      }
    },
  );
});

it("exports the revision pinned by a result card or selected in comparison", async () => {
  const pinned = ComputeResultRevisionId.make("r000000000001");
  const other = ComputeResultRevisionId.make("r000000000002");
  const href = `scient-result:${pinned}/values.json#/recall`;
  const sameValueRun = {
    revision: other,
    scriptPath: "threshold.py",
    language: "Python",
    finishedAt: "2026-11-23T09:00:00Z",
    inputTracking: "observed",
    inputs: [],
    inputsTruncated: false,
    runtime: { executable: null, version: null },
    causes: [],
  } satisfies ComputeResultSummary;
  commands.resolve.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      resolutions: [
        {
          _tag: "resolved",
          summary: {
            revision: pinned,
            scriptPath: "threshold.py",
            language: "Python",
            finishedAt: "2026-11-23T08:00:00Z",
            inputTracking: "observed",
            inputs: ["data/predictions.csv"],
            inputsTruncated: true,
            outsideDataPaths: ["~/Data/cohort.csv"],
            runtime: { executable: null, version: null },
            causes: [],
            lastAttempt: {
              status: "failed",
              finishedAt: "2026-11-23T09:01:00Z",
              message: "The run did not succeed.",
            },
          } satisfies ComputeResultSummary,
          value: "0.600",
          figure: false,
          newer: { summary: sameValueRun, value: "0.600", figure: false },
        },
      ],
    },
  });
  commands.setup.mockResolvedValue({
    _tag: "Success",
    value: {
      parameters: [{ name: "threshold", value: "0.5", source: "override" }],
      inputs: [],
    },
  });
  commands.attemptOutput.mockResolvedValue({
    _tag: "Success",
    value: {
      session: null,
      executionId: "failure",
      parameters: [{ name: "threshold", value: "1.1", source: "override" }],
      output: {
        outputs: [
          {
            _tag: "diagnostic",
            sequence: 1,
            observedAt: "2026-11-23T09:01:00Z",
            diagnostic: {
              errorName: "ValueError",
              message: "Threshold must be between 0 and 1",
              frames: [],
              traceback: [
                'File "threshold.py", line 12',
                "ValueError: Threshold must be between 0 and 1",
              ],
            },
          },
        ],
        corruptLineCount: 0,
      },
    },
  });
  commands.choices.mockReset().mockResolvedValue({ _tag: "Success", value: { inputs: [] } });
  commands.save
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { folder: "/project/package" } });
  const controller = new ScientMarkdownEditorView({
    source: `Recall [0.600](${href}).\n`,
    revision: "before",
    mode: "write",
    ariaLabel: "Markdown paper",
    onUserSourceChange: vi.fn(),
  });
  const handle = vi.fn<(value: MarkdownResultsHandle) => void>();
  const environmentId = EnvironmentId.make("fixture");
  await using screen = await render(
    <MarkdownResults
      controller={controller}
      environmentId={environmentId}
      cwd="/project"
      documentPath="paper.md"
      register={(registered) => {
        handle(registered);
        return () => {};
      }}
    />,
    // The editor and its result card do not navigate.
    { router: false },
  );
  const host = document.createElement("div");
  screen.container.append(host);
  await act(() => controller.mount(host));
  try {
    const mark = page.getByText("0.600", { exact: true });
    await expect.element(mark).toBeVisible();
    const anchor = mark.element();
    if (!(anchor instanceof HTMLElement)) throw new Error("Missing result mark");
    await act(() => handle.mock.lastCall?.[0].openCard(href, anchor));
    const card = page.getByTestId("result-card");
    await expect.element(card.getByText("0.600", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Run setup…" }).click();
    const setup = page.getByRole("dialog", { name: "Run setup" });
    await expect.element(setup.getByRole("textbox", { name: "Value" })).toHaveValue("0.5");
    await expect.element(setup.getByText("threshold.py", { exact: true })).toBeVisible();
    const setupValue = setup.getByRole("textbox", { name: "Value" });
    const beforeResize = { width: innerWidth, height: innerHeight };
    await setupValue.fill("0.65");
    try {
      await page.viewport(360, 660);
      await expect.element(setupValue).toHaveValue("0.65");
    } finally {
      await page.viewport(beforeResize.width, beforeResize.height);
    }
    await expect.element(setupValue).toHaveValue("0.65");
    await setup.getByRole("button", { name: "Cancel" }).click();
    await expect.element(card.getByText("Last run failed", { exact: true })).toBeVisible();
    const details = card.getByRole("button", { name: "Run details" });
    await details.click();
    await expect.element(card.getByText("Checked 1 input: data/predictions.csv")).toBeVisible();
    await expect
      .element(
        card.getByText(
          /Read ~\/Data\/cohort.csv outside the project.*Some file reads could not be recorded/,
        ),
      )
      .toBeVisible();
    await details.click();
    await card.getByRole("button", { name: "View output" }).click();
    const failedOutput = page.getByRole("dialog", { name: "Last run output" });
    await expect
      .element(
        failedOutput.getByText("ValueError: Threshold must be between 0 and 1", { exact: true }),
      )
      .toBeVisible();
    await expect
      .element(failedOutput.getByText('File "threshold.py", line 12', { exact: true }))
      .toBeVisible();
    await expect.element(failedOutput.getByText("1.1", { exact: true })).toBeVisible();
    await expect.element(failedOutput.getByText("threshold", { exact: true })).toBeVisible();
    expect(failedOutput.element().textContent?.match(/ValueError/g)).toHaveLength(1);
    expect(failedOutput.element().textContent).not.toContain("The run did not succeed.");
    await failedOutput.getByRole("button", { name: "Close", exact: true }).click();
    const exportName = "Export for rerun…";
    await card.getByRole("button", { name: exportName }).click();
    const dialog = page.getByRole("dialog", { name: "Export for rerun", exact: true });
    const revision = dialog.getByRole("combobox", { name: "Saved revision" });
    await expect.element(revision).toHaveValue(pinned);
    await expect.element(revision).toHaveAccessibleDescription("threshold = 0.5");
    await expect
      .element(revision.getByRole("option", { name: /threshold = 0.7/ }))
      .toBeInTheDocument();
    await revision.selectOptions(other);
    await expect.element(revision).toHaveValue(other);
    await expect.element(revision).toHaveAccessibleDescription("threshold = 0.7");
    await dialog.getByRole("button", { name: "Save package" }).click();
    const saved = page.getByRole("dialog", { name: "Result package saved" });
    await expect.element(saved.getByText("/project/package")).toBeVisible();
    expect(commands.save.mock.lastCall?.[0].input.revision).toBe(other);
    await saved.getByRole("button", { name: "Done" }).click();
    await card.getByRole("button", { name: "Compare with…" }).click();
    const compare = page.getByRole("dialog", { name: "Compare revisions" });
    await expect.element(card).not.toBeInTheDocument();
    await expect.element(compare.getByText("-0.2", { exact: true })).toBeVisible();
    const inputRow = compare.getByRole("row", { name: /data\/predictions.csv/ });
    await expect.element(inputRow.getByText("Same", { exact: true })).toBeVisible();
    await expect.element(inputRow.getByText("Observed", { exact: true })).toBeVisible();
    await expect
      .element(inputRow.getByText("Declared and observed", { exact: true }))
      .toBeVisible();
    const fromRevision = compare.getByRole("combobox", { name: "From revision", exact: true });
    const toRevision = compare.getByRole("combobox", { name: "To revision", exact: true });
    const swap = compare.getByRole("button", { name: "Swap sides", exact: true });
    const showUnchanged = compare.getByRole("checkbox", { name: "Show unchanged" });
    (fromRevision.element() as HTMLElement).focus();
    for (const control of [
      compare.getByRole("button", { name: "From revision actions" }),
      toRevision,
      compare.getByRole("button", { name: "To revision actions" }),
      swap,
      showUnchanged,
    ]) {
      await userEvent.tab();
      await expect.element(control).toHaveFocus();
    }
    const fromGrid = compare.getByRole("grid", { name: "From", exact: true });
    for (let tab = 0; tab < 14 && document.activeElement !== fromGrid.element(); tab++) {
      await userEvent.tab();
    }
    await expect.element(fromGrid).toHaveFocus();
    await expect.element(fromGrid.getByText("integer", { exact: true }).first()).toBeVisible();
    expect(getComputedStyle(fromGrid.element()).outlineStyle).toBe("solid");
    await compare.getByRole("checkbox", { name: "Show unchanged" }).click();
    await expect.element(compare.getByText("/n", { exact: true })).toBeVisible();
    await compare.getByRole("checkbox", { name: "Show unchanged" }).click();
    const enlarge = compare.getByRole("button", { name: "Enlarge roc.svg" }).first();
    await expect.element(enlarge).toBeVisible();
    await enlarge.click();
    const plot = page.getByRole("dialog", { name: "Expanded image preview" });
    await expect.element(plot).toBeVisible();
    await plot.getByRole("button", { name: "Back, close image preview" }).click();
    const from = compare.getByRole("grid", { name: "From", exact: true });
    const to = compare.getByRole("grid", { name: "To", exact: true });
    await expect.element(from).toBeInTheDocument();
    await expect.element(to).toBeInTheDocument();
    const bounds = () => [from.element(), to.element()].map((grid) => grid.getBoundingClientRect());
    const previousViewport = { width: innerWidth, height: innerHeight };
    const previousDark = document.documentElement.classList.contains("dark");
    try {
      for (const dark of [false, true]) {
        document.documentElement.classList.toggle("dark", dark);
        await page.viewport(1100, 900);
        await expect
          .poll(() => {
            const [left, right] = bounds();
            return left !== undefined && right !== undefined && left.right <= right.left;
          })
          .toBe(true);
        await page.viewport(360, 780);
        await expect
          .poll(() => {
            const [left, right] = bounds();
            return left !== undefined && right !== undefined && left.bottom <= right.top;
          })
          .toBe(true);
        const scroller = compare.element().querySelector("[data-slot=scroll-area-viewport]");
        expect(scroller?.scrollWidth).toBe(scroller?.clientWidth);
        from.element().scrollLeft = from.element().scrollWidth;
        expect(from.element().scrollLeft).toBeGreaterThan(0);
        expect(to.element().scrollLeft).toBe(0);
      }
      await compare.getByRole("button", { name: "Swap sides" }).click();
      await expect.element(compare.getByText("+0.2", { exact: true })).toBeVisible();
      await compare.getByRole("button", { name: "Swap sides" }).click();
    } finally {
      document.documentElement.classList.toggle("dark", previousDark);
      await page.viewport(previousViewport.width, previousViewport.height);
    }
    for (const [side, expectedRevision] of [
      ["From", pinned],
      ["To", other],
    ] as const) {
      await compare.getByRole("button", { name: `${side} revision actions` }).click();
      await page.getByRole("menuitem", { name: exportName }).click();
      await expect.element(revision).toHaveValue(expectedRevision);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
    }
    await compare.getByRole("button", { name: "Close", exact: true }).click();
    await expect.element(mark).toHaveFocus();
    await act(() => handle.mock.lastCall?.[0].openCard(href, anchor));
    await expect.element(card.getByText("Newer run, same value")).toBeVisible();
    await card.getByRole("button", { name: "Update link", exact: true }).click();
    expect(controller.resultReferences()[0]).toMatchObject({ revision: other, text: "0.600" });
  } finally {
    controller.destroy();
  }
});

it("inserts the chosen older revision with its own recorded value", async () => {
  const old = ComputeResultRevisionId.make("r000000000001");
  const newest = ComputeResultRevisionId.make("r000000000002");
  commands.list.mockImplementation(async ({ input }: { input: { revision?: string } }) => {
    const revision = input.revision === old ? old : newest;
    return {
      _tag: "Success",
      value: {
        scripts: [
          {
            latest: {
              revision,
              scriptPath: "threshold.py",
              language: "Python",
              finishedAt: "2026-11-23T08:00:00Z",
              inputTracking: "observed",
              inputs: [],
              inputsTruncated: false,
              runtime: { executable: null, version: null },
              causes: [],
            },
            values: [
              {
                output: "metrics.json",
                pointer: "/recall",
                value: revision === old ? "0.8" : "0.6",
              },
            ],
            revisions: 2,
            figures: [],
          },
        ],
      },
    };
  });
  const onPick = vi.fn(async () => null);
  await using _screen = await render(
    <ResultPicker
      cwd="/project"
      environmentId={EnvironmentId.make("fixture")}
      figures={() => true}
      tables={() => true}
      onPick={onPick}
      onClose={() => {}}
    />,
    { router: false },
  );
  await expect.element(page.getByText("0.6", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Choose revision…" }).click();
  await page.getByRole("combobox", { name: "Saved revision" }).click();
  await page.getByRole("option", { name: /threshold = 0.5/ }).click();
  await page.getByText("0.8", { exact: true }).click();
  expect(onPick).toHaveBeenCalledWith(
    expect.objectContaining({
      script: expect.objectContaining({ latest: expect.objectContaining({ revision: old }) }),
      value: expect.objectContaining({ value: "0.8" }),
    }),
  );
});

it("opens both package actions from a labeled icon menu in a narrow Compute pane", async () => {
  await using viewport = new AsyncDisposableStack();
  const prior = { width: innerWidth, height: innerHeight };
  viewport.defer(() => page.viewport(prior.width, prior.height));
  await page.viewport(360, 780);
  // The menu opens dialogs in the current view.
  await using screen = await render(
    <div className="@container">
      <ResultPackagePalette>
        <ResultPackageMenu environmentId={EnvironmentId.make("fixture")} cwd="/project" />
      </ResultPackagePalette>
    </div>,
    { router: false },
  );
  const trigger = screen.getByRole("button", { name: "Result packages" });
  await expect.element(trigger).toBeVisible();
  await expect.element(trigger.getByText("Result packages")).not.toBeVisible();
  commands.list.mockReset().mockResolvedValue({ _tag: "Success", value: { scripts: [] } });
  await trigger.click();
  await page.getByRole("menuitem", { name: "Export for rerun…" }).click();
  const exportDialog = page.getByRole("dialog", { name: "Export for rerun" });
  await expect.element(exportDialog.getByText("No saved results in this project.")).toBeVisible();
  await exportDialog.getByRole("button", { name: "Close" }).click();
  await trigger.click();
  await page.getByRole("menuitem", { name: "Verify a result package…" }).click();
  await expect.element(page.getByRole("dialog", { name: "Verify a result package" })).toBeVisible();
});

it("shows checked inputs without a coverage warning for an ordinary observed run", async () => {
  await using screen = await render(
    <ResultRunEvidence
      summary={{
        revision: ComputeResultRevisionId.make("r000000000001"),
        scriptPath: "threshold.py",
        language: "Python",
        finishedAt: "2026-11-23T08:00:00Z",
        inputTracking: "observed",
        inputs: ["data/predictions.csv"],
        inputsTruncated: false,
        outsideDataPaths: [],
        runtime: { executable: null, version: "3.12" },
        parameters: [{ name: "threshold", value: "0.5", source: "override" }],
        causes: [],
      }}
    />,
    { router: false },
  );
  await expect.element(screen.getByText("Checked 1 input: data/predictions.csv")).toBeVisible();
  expect(screen.container.textContent).not.toMatch(/could not|outside the project|DuckDB|At least/);
  await expect.element(screen.getByText("threshold = 0.5", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Python 3.12", { exact: true })).toBeVisible();
});
