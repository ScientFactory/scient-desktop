import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";

import { ThreadTasksBar } from "./ThreadTasksBar";

const projection = {
  plans: [
    {
      id: "plan-1",
      threadId: "thread-1",
      runId: "run-1",
      kind: "todo_list",
      status: "active",
      steps: [
        { id: "a", text: "Read the data", status: "completed" },
        { id: "b", text: "Fit the model", status: "running" },
        { id: "c", text: "Write the summary", status: "pending" },
      ],
    },
  ],
  runs: [{ id: "run-1", ordinal: 1, startedAt: "2026-11-01T10:00:00Z", providerThreadId: "p1" }],
} as unknown as ThreadStructure;

it("shows the current task, opens to every step, and stays dismissed after a reload", async () => {
  using _storage = { [Symbol.dispose]: () => localStorage.clear() };
  {
    await using screen = await render(<ThreadTasksBar projection={projection} />);
    const bar = screen.getByRole("button", { name: /^Tasks: 1 of 3 complete/ });
    await expect.element(bar.getByText("Fit the model")).toBeVisible();
    await expect.element(screen.getByRole("list")).not.toBeInTheDocument();

    await bar.click();
    await expect.element(screen.getByText("Pending: Write the summary")).toBeVisible();

    await screen.getByRole("button", { name: "Dismiss tasks" }).click();
    await expect.element(screen.getByText("Fit the model")).not.toBeInTheDocument();
  }

  await using reopened = await render(<ThreadTasksBar projection={projection} />);
  await expect.element(reopened.getByText("Fit the model")).not.toBeInTheDocument();
});
