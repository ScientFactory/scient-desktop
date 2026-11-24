import "../../index.css";

import {
  EnvironmentId,
  type DataProfileEvent,
  type DataTableColumn,
  type DataTablePage,
  type DataTableQuery,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { DataGrid } from "./DataGrid";
import { DataProfileButton } from "./DataProfileButton";

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand:
    () =>
    async ({ onEvent }: { onEvent: (event: DataProfileEvent) => void }) => {
      onEvent({
        _tag: "Complete",
        profile: {
          scope: "sample",
          rowCount: 3,
          rowsProfiled: 2,
          columnCount: 1,
          columns: [
            {
              columnIndex: 0,
              column: { name: "value", type: "number", label: "double" },
              missing: 0,
              missingShare: 0,
              missingFromFooter: true,
              distinct: 1,
              distinctFromFooter: false,
              distinctLowerBound: false,
              valuesClipped: false,
              topTracked: false,
              range: { min: "1.5", max: "1.5" },
              rangeFromFooter: true,
              top: [],
            },
          ],
        },
      });
      return { _tag: "Success" };
    },
}));

const ROWS = 1_000_000;
const COLUMNS: ReadonlyArray<DataTableColumn> = [
  { name: "id", type: "integer", label: "int64" },
  { name: "value", type: "number", label: "float64" },
  { name: "label", type: "text", label: "object" },
  { name: "when", type: "datetime", label: "datetime64[ns]" },
];

/** A million-row table computed on demand, as a source paging from disk would. */
function syntheticTable(requests: Array<DataTableQuery>) {
  return async (query: DataTableQuery): Promise<DataTablePage> => {
    requests.push(query);
    const matches = query.search === "" ? ROWS : ROWS / 10;
    const end = Math.min(matches, query.offset + query.limit);
    const rows = [];
    for (let position = query.offset; position < end; position++) {
      const row = query.sort?.descending ? matches - 1 - position : position;
      const id = query.search === "" ? row : row * 10;
      rows.push({
        label: String(id + 1),
        cells: [
          String(id),
          (id / 7).toFixed(4),
          id % 3 === 0 ? null : `sample ${id}`,
          "2024-01-01",
        ],
      });
    }
    return {
      columns: COLUMNS,
      columnCount: COLUMNS.length,
      rowCount: ROWS,
      matchCount: matches,
      truncated: false,
      offset: query.offset,
      rows,
    };
  };
}

describe("DataGrid", () => {
  it("draws only the rows on screen and pages the rest as they scroll into view", async () => {
    const host = document.createElement("div");
    host.style.cssText = "width: 900px; height: 480px; display: flex; flex-direction: column;";
    const requests: Array<DataTableQuery> = [];
    await using screen = await render(
      <DataGrid label="measurements.csv" revision="1" loadPage={syntheticTable(requests)} />,
      { container: host, router: false },
    );
    const grid = () => host.querySelector<HTMLElement>('[role="grid"]')!;
    await vi.waitFor(() => expect(host.textContent).toContain("sample 1"));

    expect(
      [...host.querySelectorAll('[role="columnheader"]')].map((node) => node.textContent),
    ).toEqual(["idinteger", "valuedecimal", "labeltext", "whendate and time"]);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.textContent).toContain("1,000,000 rows · 4 columns");
    expect(host.textContent).toContain("null");
    expect(host.querySelectorAll('[role="row"]').length).toBeLessThan(25);
    const screenshot = async (name: string) => {
      const directory = import.meta.env.VITE_SCIENT_DATA_GRID_SCREENSHOTS;
      if (directory) await page.screenshot({ path: `${directory}/${name}.png`, element: host });
    };
    await screenshot("top");

    await act(() => {
      grid().scrollTop = grid().scrollHeight;
      grid().dispatchEvent(new Event("scroll"));
    });
    await vi.waitFor(() => expect(host.textContent).toContain("sample 999998"));
    expect(requests.at(-1)?.offset).toBeGreaterThan(990_000);
    expect(host.querySelectorAll('[role="row"]').length).toBeLessThan(25);
    await screenshot("bottom");

    await act(() => host.querySelector<HTMLElement>('[role="columnheader"] button')!.click());
    await vi.waitFor(() =>
      expect(requests.at(-1)).toMatchObject({ offset: 0, sort: { column: 0, descending: false } }),
    );

    await screen.getByRole("searchbox").fill("sample 5");
    await vi.waitFor(() => expect(host.textContent).toContain("100,000 of 1,000,000 rows"));
    expect(requests.at(-1)?.search).toBe("sample 5");
    await screenshot("search");
  });

  it("reports the grid's actual row and column caps", async () => {
    const host = document.createElement("div");
    host.style.cssText = "width: 900px; height: 480px; display: flex; flex-direction: column;";
    const load = syntheticTable([]);
    await using screen = await render(
      <DataGrid
        label="capped.csv"
        revision="1"
        loadPage={async (query) => ({
          ...(await load(query)),
          columnCount: 1200,
          truncated: true,
        })}
      />,
      { container: host, router: false },
    );
    const notice = screen.getByRole("status");
    await expect
      .element(
        notice.getByText(
          "Only the first 1,000,000 rows are available. Search and sort use these rows.",
          { exact: true },
        ),
      )
      .toBeVisible();
    await expect
      .element(
        notice.getByText("Showing the first 4 of 1,200 columns.", {
          exact: true,
        }),
      )
      .toBeVisible();
  });

  it("uses the same type name for CSV grid data and the Parquet profile while preserving source labels", async () => {
    const host = document.createElement("div");
    host.style.cssText = "width: 900px; height: 480px; display: flex; flex-direction: column;";
    const load = syntheticTable([]);
    await using screen = await render(
      <DataGrid
        label="measurements.csv"
        revision="1"
        loadPage={async (query) => {
          const result = await load(query);
          return {
            ...result,
            columns: result.columns.map((column) =>
              column.type === "number" ? { ...column, label: "float" } : column,
            ),
          };
        }}
        toolbarEnd={
          <DataProfileButton
            environmentId={EnvironmentId.make("type-test")}
            sourceLabel="measurements.parquet"
            target={{ kind: "file", input: { path: "/p/measurements.parquet", sheet: 0 } }}
          />
        }
      />,
      { container: host, router: false },
    );
    await expect.element(screen.getByRole("columnheader", { name: "value decimal" })).toBeVisible();
    await screen.getByText("decimal", { exact: true }).hover();
    await expect
      .poll(() => page.getByRole("tooltip").query()?.textContent, { timeout: 3000 })
      .toBe("float");
    await screen.getByRole("button", { name: "Column profile" }).click();
    const dialog = page.getByRole("dialog", { name: "Column profile" });
    await expect
      .element(dialog.getByRole("cell", { name: "0 (0%) File nulls · all rows" }))
      .toBeVisible();
    await expect
      .element(dialog.getByRole("cell", { name: "1 Sample · first 2 rows" }))
      .toBeVisible();
    await expect.element(dialog.getByRole("cell", { name: "1.5 to 1.5 All rows" })).toBeVisible();
    const profileType = page.getByRole("cell", { name: "decimal", exact: true });
    await profileType.getByText("decimal", { exact: true }).hover();
    await expect
      .poll(() => page.getByRole("tooltip").query()?.textContent, { timeout: 3000 })
      .toBe("double");
  });

  it("applies and clears a numeric filter in the grid's page query", async () => {
    const host = document.createElement("div");
    host.style.cssText = "width: 420px; height: 420px; display: flex; flex-direction: column;";
    const requests: Array<DataTableQuery> = [];
    await using screen = await render(
      <DataGrid
        label="measurements.csv"
        revision="1"
        enableMinimumFilter
        loadPage={syntheticTable(requests)}
      />,
      { container: host, router: false },
    );
    await screen.getByRole("button", { name: "Grid actions" }).click();
    await page.getByRole("menuitem", { name: "Filter rows…" }).click();
    const picker = page.getByRole("combobox", { name: "Numeric column" });
    await expect.element(picker).toHaveTextContent("id");
    await picker.click();
    await page.getByRole("option", { name: "value", exact: true }).click();
    await expect.element(picker).toHaveTextContent("value");
    await page.getByRole("spinbutton", { name: "Keep values at or above" }).fill("0.5");
    await page.getByRole("button", { name: "Apply filter" }).click();
    await vi.waitFor(() => expect(requests.at(-1)?.minimum).toEqual({ column: 1, value: 0.5 }));
    await expect.element(screen.getByText("Filter applied · value ≥ 0.5")).toBeVisible();
    await screen.getByRole("button", { name: "Grid actions" }).click();
    await page.getByRole("menuitem", { name: "Filter rows…" }).click();
    await page.getByRole("button", { name: "Clear filter" }).click();
    await vi.waitFor(() => expect(requests.at(-1)?.minimum).toBeUndefined());
  });
});
