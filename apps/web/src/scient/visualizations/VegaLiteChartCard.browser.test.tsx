import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { VegaLiteChartCard } from "./VegaLiteChartCard";

const stackedBar = {
  data: {
    values: [
      { row: "All", group: "A", count: 6 },
      { row: "All", group: "B", count: 9 },
    ],
  },
  mark: "bar",
  encoding: {
    x: { field: "count", type: "quantitative", stack: "zero" },
    y: { field: "row", type: "nominal", axis: null },
    color: { field: "group", type: "nominal" },
  },
};

const verticalBar = {
  ...stackedBar,
  encoding: { ...stackedBar.encoding, x: stackedBar.encoding.y, y: stackedBar.encoding.x },
  width: { step: 20 },
  height: "container",
};

const heightWarning = 'Dropping "fit-y" because spec has discrete height.';
const widthWarning = 'Dropping "fit-x" because spec has discrete width.';

it.each([
  { sizing: "responsive defaults", chart: stackedBar, warning: heightWarning, warns: false },
  {
    sizing: "horizontal fit",
    chart: { ...stackedBar, width: "container", autosize: "fit-x" },
    warning: heightWarning,
    warns: false,
  },
  {
    sizing: "horizontal fit with a fixed width",
    chart: { ...stackedBar, width: 320, autosize: "fit-x" },
    warning: heightWarning,
    warns: false,
  },
  {
    sizing: "horizontal fit set in config",
    chart: { ...stackedBar, width: "container", config: { autosize: { type: "fit-x" } } },
    warning: heightWarning,
    warns: false,
  },
  {
    sizing: "explicit fit on both axes",
    chart: { ...stackedBar, width: "container", autosize: "fit" },
    warning: heightWarning,
    warns: true,
  },
  {
    sizing: "vertical fit",
    chart: verticalBar,
    warning: widthWarning,
    warns: false,
  },
  {
    sizing: "vertical chart with explicit fit on both axes",
    chart: { ...verticalBar, autosize: "fit" },
    warning: widthWarning,
    warns: true,
  },
])("keeps diagnostics out of the chat flow with $sizing", async ({ chart, warning, warns }) => {
  await using screen = await render(
    <VegaLiteChartCard
      language="vega-lite"
      source={JSON.stringify(chart)}
      theme="light"
      title="Completed runs"
    />,
    { router: false },
  );

  await expect
    .element(screen.getByRole("button", { name: "Expand interactive chart" }))
    .toBeVisible();
  await expect.element(screen.getByText(warning)).not.toBeInTheDocument();
  const more = screen.getByRole("button", { name: "More chart actions" });
  await more.click();
  const menu = page.getByRole("menu");
  await expect.element(menu.getByText("Copy source")).toBeVisible();
  const warningRow = menu.getByRole("menuitem", { name: "Chart warnings (1)" });
  await expect.element(menu.getByText(warning)).not.toBeInTheDocument();
  if (warns) {
    await expect.element(warningRow).toBeVisible();
    const popup = menu.element();
    (warningRow.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(menu.getByText(warning)).toBeVisible();
    await expect.element(menu.getByText("Copy source")).not.toBeInTheDocument();
    expect(menu.element()).toBe(popup);
    const back = menu.getByRole("menuitem", { name: "Back" });
    await expect.element(back).toHaveFocus();

    await userEvent.keyboard("{Enter}");
    await expect.element(warningRow).toHaveFocus();
    await expect.element(menu.getByText("Copy source")).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect.element(back).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(menu).not.toBeInTheDocument();
    await more.click();
    await expect.element(warningRow).toBeVisible();
    await expect.element(menu.getByText(warning)).not.toBeInTheDocument();
  } else {
    await expect.element(warningRow).not.toBeInTheDocument();
  }
});

it("opens malformed chart source on demand from the compact error", async () => {
  const source = '{ "mark": "bar",';
  await using screen = await render(
    <VegaLiteChartCard language="vega-lite" source={source} theme="light" title={null} />,
    { router: false },
  );

  await expect.element(screen.getByText("Unable to render this chart")).toBeVisible();
  expect(screen.container.querySelector("pre")).toBeNull();
  await screen.getByRole("button", { name: "More chart actions" }).click();
  await page.getByRole("menuitem", { name: "Show source" }).click();
  await expect.element(screen.getByText(source, { exact: true })).toBeVisible();
});
