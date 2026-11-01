import type { DesktopUpdateState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

const state = vi.hoisted(() => ({ update: null as DesktopUpdateState | null }));
vi.mock(import("../../env"), async (original) => ({ ...(await original()), isElectron: true }));
vi.mock(import("../../state/desktopUpdate"), async (original) => ({
  ...(await original()),
  useDesktopUpdateState: () => state.update,
}));
vi.mock(import("./useUpdateEverything"), async (original) => ({
  ...(await original()),
  useUpdateEverything: (() => ({
    hasUpdates: false,
    otherServers: [],
    summary: "",
    run: vi.fn(),
  })) as never,
}));
vi.mock(import("./updateEverythingRun"), async (original) => ({
  ...(await original()),
  useUpdateEverythingRun: () => null,
}));
vi.mock(import("../../scient/desktopUpdate/SidebarOtherUpdates"), async (original) => ({
  ...(await original()),
  SidebarOtherUpdates: () => null,
}));

function setup(channel: "beta" | "latest") {
  state.update = {
    enabled: true,
    status: "available",
    channel,
    currentVersion: "0.6.23",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.6.24-beta.20261020.1",
    downloadedVersion: null,
    releaseNotes: [
      { version: "0.6.24-beta.20261020.1", items: ["A reviewed Beta change"], totalItems: 1 },
    ],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

it.each(["beta", "latest"] as const)(
  "opens release notes by native keyboard focus only on the Beta channel: %s",
  async (channel) => {
    setup(channel);
    await using screen = await render(
      <SidebarProvider>
        <button>Before updater</button>
        <ul>
          <SidebarUpdatePill />
        </ul>
      </SidebarProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Before updater" }));
    await userEvent.tab();
    expect(document.activeElement?.getAttribute("aria-label")).toContain("Update");
    if (channel === "beta") {
      await vi.waitFor(() => expect(document.body.textContent).toContain("A reviewed Beta change"));
    } else expect(document.body.textContent).not.toContain("A reviewed Beta change");
  },
);
