import "../../index.css";

import type { DesktopUpdateState } from "@t3tools/contracts";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

import { SidebarUpdatePill } from "~/components/sidebar/SidebarUpdatePill";
import { SidebarFooter, SidebarMenu, SidebarProvider } from "~/components/ui/sidebar";
import { TooltipProvider } from "~/components/ui/tooltip";
import { applyThemePalette } from "~/themePalette";

const fixture = vi.hoisted(() => ({
  updateState: null as DesktopUpdateState | null,
  remote: false,
}));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/state/desktopUpdate", () => ({
  useDesktopUpdateState: () => fixture.updateState,
}));
vi.mock("~/components/sidebar/useUpdateEverything", () => ({
  useUpdateEverything: (localVersion: string | null) => ({
    hasUpdates: fixture.remote,
    summary: localVersion ? "Update this app and 2 providers" : "Update 2 providers",
    lines: [],
    restarts: [],
    run: async () => {},
    scient: {
      details: [
        ...(localVersion
          ? [{ key: "this-app", label: "This app", items: [`${localVersion} · restarts last`] }]
          : []),
        {
          key: "alvin",
          label: "alvin",
          items: [
            "Codex 0.48.0 → 0.50.1 · managed by Scient",
            "Claude 2.1.3 → 2.2.0 · system install",
          ],
        },
      ],
      remoteSummary: fixture.remote ? "Update 2 providers" : null,
    },
  }),
}));

const appUpdate: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "latest",
  currentVersion: "1.4.2",
  availableVersion: "1.5.0",
  downloadedVersion: null,
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

let host: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  host?.remove();
  applyThemePalette("system");
  document.documentElement.classList.remove("dark");
});

async function mountButton(input: {
  readonly updateState: DesktopUpdateState | null;
  readonly remote: boolean;
}) {
  fixture.updateState = input.updateState;
  fixture.remote = input.remote;
  host = document.createElement("div");
  Object.assign(host.style, { width: "240px", padding: "16px" });
  host.className = "bg-sidebar";
  document.body.append(host);
  root = createRoot(host);
  root.render(
    <SidebarProvider className="min-h-0">
      <TooltipProvider>
        <SidebarFooter className="w-full">
          <SidebarMenu>
            <SidebarUpdatePill />
          </SidebarMenu>
        </SidebarFooter>
      </TooltipProvider>
    </SidebarProvider>,
  );
  await expect.poll(() => host!.querySelector("button")).not.toBeNull();
  return host!.querySelector("button")!;
}

async function hoverTooltip(button: HTMLButtonElement) {
  await userEvent.hover(button);
  await expect.poll(() => document.querySelector('[data-slot="tooltip-popup"]')).not.toBeNull();
  return document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]')!.textContent ?? "";
}

it("keeps the app's look when providers also have updates, and lists everything it updates", async () => {
  const button = await mountButton({ updateState: appUpdate, remote: true });
  expect(button.className).toContain("bg-primary");
  expect(button.querySelector(".lucide-download")).not.toBeNull();
  const tooltip = await hoverTooltip(button);
  expect(tooltip).toContain("Update this app and 2 providers");
  expect(tooltip).toContain("1.5.0 · restarts last");
  expect(tooltip).toContain("Codex 0.48.0 → 0.50.1 · managed by Scient");
});

it("gives providers and servers alone a quieter look with a 13px icon", async () => {
  const button = await mountButton({ updateState: null, remote: true });
  expect(button.className).toContain("bg-sidebar-control-surface");
  expect(button.className).not.toContain("bg-primary");
  expect(button.querySelector("svg")!.getBoundingClientRect().width).toBe(13);
  expect(await hoverTooltip(button)).toContain("Claude 2.1.3 → 2.2.0 · system install");
});

it("says what can update after a Restart, which stays a direct restart", async () => {
  const button = await mountButton({
    updateState: { ...appUpdate, status: "downloaded", downloadedVersion: "1.5.0" },
    remote: true,
  });
  expect(button.textContent).toContain("Restart");
  expect(button.getAttribute("aria-label")).toContain("Then update 2 providers.");
});

// Renders for choosing the shared-update colour: VITE_SCIENT_SIDEBAR_SCREENSHOTS=<dir>.
const screenshots = import.meta.env.VITE_SCIENT_SIDEBAR_SCREENSHOTS as string | undefined;
it
  .skipIf(!screenshots)
  .each(
    ["system", "t3-chat", "grove", "ocean", "ember", "iris"].flatMap((theme) =>
      (["light", "dark"] as const).map((appearance) => ({ theme, appearance })),
    ),
  )("renders every look in $theme $appearance", async ({ theme, appearance }) => {
  applyThemePalette(theme, appearance);
  document.documentElement.classList.toggle("dark", appearance === "dark");
  const states = [
    ["app", { updateState: appUpdate, remote: false }],
    ["app-with-others", { updateState: appUpdate, remote: true }],
    [
      "restart",
      {
        updateState: { ...appUpdate, status: "downloaded" as const, downloadedVersion: "1.5.0" },
        remote: true,
      },
    ],
    ["shared", { updateState: null, remote: true }],
  ] as const;
  for (const [name, state] of states) {
    const button = await mountButton(state);
    await page.screenshot({
      path: `${screenshots}/${theme}-${appearance}-${name}.png`,
      element: host!,
    });
    if (name === "shared") {
      // The alternative: a muted teal.
      Object.assign(button.style, {
        background: appearance === "dark" ? "#5fb3ad" : "#2f7f7a",
        color: appearance === "dark" ? "#0b1f1e" : "#ffffff",
        boxShadow: "none",
        transition: "none",
      });
      await page.screenshot({
        path: `${screenshots}/${theme}-${appearance}-shared-teal.png`,
        element: host!,
      });
    }
    root?.unmount();
    host?.remove();
  }
});
