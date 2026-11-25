import { expect, it } from "@effect/vitest";
import type { NotebookCellView } from "@t3tools/contracts";

import { planNotebookRun } from "./notebookRunPlan.ts";

function cell(id: string, source: string, flags: Partial<NotebookCellView> = {}): NotebookCellView {
  return {
    id,
    source,
    cellType: "code",
    executionCount: null,
    pendingExecution: null,
    outputs: [],
    run: null,
    ...flags,
  };
}

it("replaces prior injection and hashes the same ordered code that will be saved", () => {
  const notebook = {
    revision: "snapshot",
    language: "python",
    cells: [
      cell("parameters", "limit = 2\nlabels = ['a']\nflag = True", { parameterCell: true }),
      cell("old", "limit = 9", { injectedParameters: true }),
      cell("analysis", "print(limit, labels, flag)"),
    ],
  };
  const plan = planNotebookRun(
    notebook,
    {
      limit: "0",
      labels: '["\\\"\\nprint(42)"]',
      flag: "false",
    },
    "injected",
  );
  expect(plan.cells.map((entry) => entry.id)).toEqual(["parameters", "injected", "analysis"]);
  expect(plan.injection?.source).toBe(
    '# Parameters\nlimit = 0\nlabels = ["\\\"\\nprint(42)"]\nflag = False',
  );
  expect(plan.parameters.map(({ value, source }) => [value, source])).toEqual([
    ["0", "override"],
    ['["\\\"\\nprint(42)"]', "override"],
    ["false", "override"],
  ]);
  expect(planNotebookRun(notebook, {}, "injected").cells.map(({ id }) => id)).toEqual([
    "parameters",
    "analysis",
  ]);
  expect(() => planNotebookRun(notebook, { missing: "1" }, "injected")).toThrow("cannot use");
  expect(() => planNotebookRun(notebook, { limit: "1.5" }, "injected")).toThrow("cannot use");
  const julia = {
    ...notebook,
    language: "julia",
    cells: [cell("p", "rate = 1.0", { parameterCell: true })],
  };
  expect(planNotebookRun(julia, {}, "injected").parameters[0]?.value).toBe("1.0");
  const decimal = planNotebookRun(julia, { rate: "2" }, "injected");
  expect(decimal.injection?.source).toBe("# Parameters\nrate = 2.0");
  expect(decimal.parameterEnvironment).toBe('{"rate":2.0}');
});
