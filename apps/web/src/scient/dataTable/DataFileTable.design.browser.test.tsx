import "../../index.css";

import {
  EnvironmentId,
  ThreadId,
  type DataProfileEvent,
  type DataViewMaterializeInput,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { ProfileTarget } from "./dataTableState";

const { exported, sources } = vi.hoisted(() => ({
  sources: { revision: "view-revision-1" },
  exported: vi.fn(async ({ input }: { input: DataViewMaterializeInput }) => ({
    _tag: "Success",
    value: { path: input.destination },
  })),
}));

vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Success", fileRevision: "r1" }),
}));

vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner:
    (family: string | undefined) =>
    async ({ input }: { input: { path: string; revision?: string } }) => {
      if (family === "view-revision") return { _tag: "Success", value: sources.revision };
      const rowCount = input.path.endsWith(".sql") ? 4 : 10;
      return {
        _tag: "Success",
        value: {
          columns: [{ name: "score", type: "number", label: "double" }],
          columnCount: 1,
          rowCount,
          matchCount: rowCount,
          truncated: false,
          offset: 0,
          sheets: [],
          rows: Array.from({ length: rowCount }, (_, index) => ({
            label: String(index + 1),
            cells: [input.revision === "view-revision-2" ? "0.77" : "0.95"],
          })),
        },
      };
    },
}));

vi.mock("~/components/files/ProjectFilePicker", () => ({
  ProjectFilePickerForTarget: () => <button type="button">threshold.py</button>,
}));

vi.mock("~/state/compute", async () => {
  const { Atom } = await import("effect/reactivity");
  const permission = Atom.make(true);
  return {
    computeEnvironment: {
      notebookRead: { label: "read" },
      resultsSetup: { label: "setup" },
      resultsRerun: { label: "rerun", permissionAtom: () => permission },
    },
  };
});

vi.mock("./dataTableState", async () => {
  const { Atom } = await import("effect/reactivity");
  const permission = Atom.make(true);
  return {
    dataFileTablePage: undefined,
    dataViewPage: undefined,
    dataViewRevision: "view-revision",
    dataProfile: { label: "profile" },
    saveDataView: { label: "save", permissionAtom: () => permission },
    materializeDataView: { label: "export", permissionAtom: () => permission },
  };
});

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly label: string }) =>
    command.label === "export"
      ? exported
      : async ({
          target,
          onEvent,
        }: {
          readonly target: ProfileTarget;
          readonly onEvent: (event: DataProfileEvent) => void;
        }) => {
          const rowCount = target.kind === "view" ? 4 : 10;
          onEvent({
            _tag: "Complete",
            profile: {
              scope: "all",
              rowCount,
              rowsProfiled: rowCount,
              columnCount: 1,
              columns: [
                {
                  columnIndex: 0,
                  column: { name: "score", type: "number", label: "double" },
                  missing: 0,
                  missingShare: 0,
                  missingFromFooter: false,
                  distinct: 3,
                  distinctFromFooter: false,
                  distinctApproximate: true,
                  distinctLowerBound: false,
                  valuesClipped: false,
                  range: { min: "0.70", max: "0.95" },
                  rangeFromFooter: false,
                  topTracked: false,
                  top: [],
                },
              ],
            },
          });
          return { _tag: "Success" };
        },
}));

import { DataFileTable } from "./DataFileTable";

const screenshotDirectory = import.meta.env.VITE_SCIENT_DATA_GRID_SCREENSHOTS;

it.each(screenshotDirectory ? (["light", "dark"] as const) : (["light"] as const))(
  "fits saved-view actions and their dialogs at 360 px in %s mode",
  async (theme) => {
    await using restore = new AsyncDisposableStack();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const root = document.documentElement;
    const dark = root.classList.contains("dark");
    restore.defer(() => {
      root.classList.toggle("dark", dark);
      return page.viewport(viewport.width, viewport.height);
    });
    await page.viewport(360, 760);
    root.classList.toggle("dark", theme === "dark");

    exported.mockClear();
    sources.revision = "view-revision-1";
    const showSql = vi.fn();
    const open = vi.fn();
    const file = (path: string, viewSql?: string, refreshToken = "1") => (
      <div className="flex h-dvh min-w-0 flex-col bg-background text-foreground">
        <DataFileTable
          key={path}
          environmentId={EnvironmentId.make("environment")}
          absolutePath={`/project/${path}`}
          name={path.split("/").at(-1) ?? path}
          threadId={ThreadId.make("thread")}
          workspace={{ cwd: "/project", path, onOpenPath: open }}
          viewSql={viewSql}
          onShowSql={showSql}
          refreshToken={refreshToken}
          reloadKey="0"
        />
      </div>
    );

    const viewPath = "views/high_risk.sql";
    const viewSql =
      "SELECT * FROM 'data/predictions.parquet' JOIN 'data/threshold.csv' USING (id) JOIN 'data/check.csv' USING (id) JOIN other_input USING (id)";
    await using screen = await render(
      file(viewPath, viewSql),
      { router: false }, // This fixture stays inside the Files surface.
    );
    const capture = async (name: string) => {
      if (screenshotDirectory)
        await page.screenshot({ path: `${screenshotDirectory}/${name}-${theme}.png` });
    };

    const banner = screen.getByRole("region", { name: "Saved view" });
    await expect
      .element(banner.getByText("data/predictions.parquet", { exact: true }))
      .toBeVisible();
    await banner.getByRole("button", { name: "Source coverage is incomplete" }).click();
    await expect.element(banner.getByText("data/check.csv", { exact: true })).toBeVisible();
    await expect.element(banner.getByText("other_input", { exact: true })).toBeVisible();
    await banner.getByRole("button", { name: "Source coverage is incomplete" }).click();
    await banner.getByRole("button", { name: "Show SQL" }).click();
    expect(showSql).toHaveBeenCalledOnce();

    const actions = screen.getByRole("button", { name: "Grid actions" });
    for (const control of [
      screen.getByRole("searchbox"),
      screen.getByRole("button", { name: "Column profile" }),
      actions,
    ]) {
      await expect.element(control).toBeVisible();
      const bounds = control.element().getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(360);
    }
    (actions.element() as HTMLButtonElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("menuitem", { name: "Filter rows…" })).toBeEnabled();
    await expect.element(page.getByRole("menuitem", { name: "Use in analysis…" })).toBeEnabled();
    await capture("grid-menu-360");
    await page.getByRole("menuitem", { name: "Filter rows…" }).click();
    const filter = page.getByRole("dialog", { name: "Filter rows by a minimum value" });
    await filter.getByRole("spinbutton", { name: "Keep values at or above" }).fill("0.7");
    await filter.getByRole("button", { name: "Apply filter" }).click();
    await expect.element(screen.getByText("Filter applied · score ≥ 0.7")).toBeVisible();
    await expect.element(actions).toHaveFocus();

    await actions.click();
    await page.getByRole("menuitem", { name: "Export table…" }).click();
    const exportDialog = page.getByRole("dialog", { name: "Export derived table…" });
    await expect
      .element(
        exportDialog.getByText(
          "Export all rows from views/high_risk.sql that match the grid’s search and filters, in grid order.",
        ),
      )
      .toBeVisible();
    const outputFormat = exportDialog.getByRole("combobox", { name: "Format" });
    await expect.element(outputFormat).toHaveTextContent("Parquet");
    await outputFormat.click();
    await page.getByRole("option", { name: "CSV" }).click();
    const destination = exportDialog.getByRole("textbox", { name: "Project file path" });
    await expect.element(destination).toHaveValue("high_risk.csv");
    await destination.fill("derived/high_risk.csv");
    await capture("derived-export-360");
    await exportDialog.getByRole("button", { name: "Export table", exact: true }).click();
    expect(exported).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          cwd: "/project",
          path: "views/high_risk.sql",
          destination: "derived/high_risk.csv",
          revision: "view-revision-1",
          filter: { search: "", sort: null, minimum: { column: 0, value: 0.7 } },
        },
      }),
    );
    await expect.element(actions).toHaveFocus();

    await actions.click();
    await page.getByRole("menuitem", { name: "Use in analysis…" }).click();
    const picker = page.getByRole("dialog", { name: "Choose analysis file" });
    await expect.element(picker).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(picker).not.toBeInTheDocument();

    await screen.getByRole("searchbox").fill("0.95");
    await screen.getByRole("button", { name: "Column profile" }).click();
    const profile = page.getByRole("dialog", { name: "Column profile" });
    await expect
      .element(
        profile.getByText("All 4 rows in views/high_risk.sql · Before grid search and filters"),
      )
      .toBeVisible();
    await expect.element(profile.getByRole("cell", { name: "≈3", exact: true })).toBeVisible();
    expect(profile.element().getBoundingClientRect().width).toBeLessThanOrEqual(328.5);
    if (screenshotDirectory) {
      await expect.poll(() => getComputedStyle(profile.element()).opacity).toBe("1");
      await capture("profile-360");
    }
    const statistics = profile.getByRole("region", { name: "Column statistics" }).element();
    expect(statistics.scrollWidth).toBeGreaterThan(statistics.clientWidth);
    statistics.scrollLeft = statistics.scrollWidth;
    const range = profile.getByRole("cell", { name: "0.70 to 0.95" }).element();
    expect(range.getBoundingClientRect().right).toBeLessThanOrEqual(
      statistics.getBoundingClientRect().right + 0.5,
    );

    await page.viewport(1200, 800);
    await expect.poll(() => profile.element().getBoundingClientRect().width).toBe(960);
    await capture("profile-wide");
    await profile.getByRole("button", { name: "Close" }).click();

    sources.revision = "view-revision-2";
    await screen.rerender(file(viewPath, viewSql, "2"));
    await expect.element(screen.getByText("0.77", { exact: true }).first()).toBeVisible();
    await expect.element(screen.getByText("Filter applied · score ≥ 0.7")).not.toBeInTheDocument();

    await screen.rerender(file("data/predictions.csv"));
    await screen.getByRole("button", { name: "Column profile" }).click();
    await expect
      .element(
        profile.getByText("All 10 rows in data/predictions.csv · Before grid search and filters"),
      )
      .toBeVisible();
    await profile.getByRole("button", { name: "Close" }).click();
    await screen.getByRole("button", { name: "Grid actions" }).click();
    await expect.element(page.getByRole("menuitem", { name: "Save as view…" })).toBeEnabled();
  },
);
