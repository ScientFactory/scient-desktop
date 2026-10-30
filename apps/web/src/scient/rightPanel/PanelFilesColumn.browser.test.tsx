import type { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";

import { render } from "../../../test/render";
import { PanelFilesLayout } from "./PanelFilesColumn";

vi.mock("~/components/files/FileBrowserPanel", () => ({
  default: () => <div>Project files</div>,
}));

const browser = {
  id: "browser:tab-1",
  kind: "preview",
  resourceId: "tab-1",
} as const satisfies RightPanelSurface;

it("resizes the file list beside a browser tab like the file viewer's", async () => {
  using _storage = {
    [Symbol.dispose]: () => {
      localStorage.removeItem("t3code.fileExplorerOpen");
      localStorage.removeItem("t3code.fileExplorerWidth");
    },
  };
  localStorage.setItem("t3code.fileExplorerOpen", "true");
  await using screen = await render(
    <div style={{ display: "flex", flexDirection: "column", width: 900, height: 400 }}>
      <PanelFilesLayout
        surface={browser}
        environmentId={"env-1" as EnvironmentId}
        cwd="/project"
        projectName="Project"
        workspaceMutationId={null}
        onOpenFile={() => {}}
        onOpenFileSource={() => {}}
      >
        <div>Browser page</div>
      </PanelFilesLayout>
    </div>,
  );
  await expect.element(screen.getByText("Project files")).toBeVisible();
  const explorer = screen.container.querySelector<HTMLElement>(
    'aside[aria-label="File explorer"]',
  )!;
  const handle = screen.getByRole("separator", { name: "Resize file explorer" }).element();
  const start = explorer.getBoundingClientRect().width;
  const { left, top } = handle.getBoundingClientRect();
  const pointer = { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientY: top + 10 };
  handle.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: left }));
  handle.dispatchEvent(new PointerEvent("pointermove", { ...pointer, clientX: left - 100 }));
  handle.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: left - 100 }));

  await vi.waitFor(() =>
    expect(explorer.getBoundingClientRect().width).toBeCloseTo(start + 100, 0),
  );
});
