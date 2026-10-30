import "../../index.css";

import type { DataTableColumn, DataTablePage, DataTableQuery } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { DataGrid } from "./DataGrid";

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
        cells: [String(id), (id / 7).toFixed(4), id % 3 === 0 ? null : `sample ${id}`, "2024-01-01"],
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
    ).toEqual(["idint64", "valuefloat64", "labelobject", "whendatetime64[ns]"]);
    expect(host.textContent).toContain("1,000,000 rows · 4 columns");
    expect(host.textContent).toContain("null");
    expect(host.querySelectorAll('[role="row"]').length).toBeLessThan(25);
    const screenshot = async (name: string) => {
      const directory = import.meta.env.VITE_SCIENT_DATA_GRID_SCREENSHOTS;
      if (directory) await page.screenshot({ path: `${directory}/${name}.png`, element: host });
    };
    await screenshot("top");
    const counts = [...host.querySelectorAll("span")].find((node) => node.textContent?.includes("4 columns"))!;
    console.log("DBG", JSON.stringify(counts.getBoundingClientRect()), getComputedStyle(counts).color, getComputedStyle(counts.parentElement!).display, counts.parentElement!.getBoundingClientRect().width);

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
});
