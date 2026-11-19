import type { PreviewStreamControl } from "@t3tools/client-runtime/preview/server-browser-stream";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { BrowserControlChip } from "./BrowserControlChip";

const agent = vi.hoisted(() => ({ working: false }));

vi.mock("~/state/entities", () => ({ useQuietThreadShell: () => ({}) }));
vi.mock("@t3tools/client-runtime/state/thread-inbox", () => ({
  isThreadWorking: () => agent.working,
}));

const youControl: PreviewStreamControl = {
  canOperate: true,
  controller: "you",
  generation: 1,
  dialog: null,
};

const renderChip = (working: boolean) => {
  agent.working = working;
  return render(
    <BrowserControlChip
      control={youControl}
      environmentId={EnvironmentId.make("environment-chip")}
      threadId="thread-chip"
      position="top"
      onTake={() => {}}
      onRelease={() => {}}
    />,
    { router: false },
  );
};

it("offers to hand back a tab you hold while the thread's agent works", async () => {
  await using screen = await renderChip(true);
  await expect.element(screen.getByRole("button", { name: "Hand back" })).toBeVisible();
});

it("stays out of the way while you browse a tab on your own", async () => {
  await using screen = await renderChip(false);
  expect(screen.container.textContent).toBe("");
});
