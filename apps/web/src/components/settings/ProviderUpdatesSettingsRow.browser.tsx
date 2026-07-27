// FILE: ProviderUpdatesSettingsRow.browser.tsx
// Purpose: Browser regressions for the actual Settings provider-update section states.
// Layer: Vitest browser tests

import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ProviderUpdatesSettingsRow } from "./ProviderUpdatesSettingsRow";

function status(
  provider: ProviderKind,
  overrides: Partial<ServerProviderStatus> = {},
): ServerProviderStatus {
  return {
    provider,
    status: "ready",
    available: true,
    authStatus: "authenticated",
    version: "1.0.0",
    checkedAt: "2026-07-26T09:00:00.000Z",
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "provider update",
      canUpdate: true,
      checkedAt: "2026-07-26T09:00:01.000Z",
      message: "Update available.",
    },
    ...overrides,
  };
}

const settings = {
  providers: DEFAULT_SERVER_SETTINGS.providers,
  enableProviderUpdateChecks: true,
};

describe("ProviderUpdatesSettingsRow", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders truthful pending and unknown/failed route states without Update", async () => {
    const view = await render(
      <ProviderUpdatesSettingsRow
        providers={[]}
        hiddenProviders={[]}
        serverSettings={null}
        loading
        locallyUpdatingProviders={new Set()}
        onUpdate={vi.fn()}
      />,
    );
    await expect.element(page.getByText("Checking provider updates…")).toBeVisible();

    await view.rerender(
      <ProviderUpdatesSettingsRow
        providers={[
          status("cursor", {
            versionAdvisory: {
              ...status("cursor").versionAdvisory!,
              status: "unknown",
              latestVersion: null,
              updateCommand: null,
              canUpdate: false,
            },
          }),
        ]}
        hiddenProviders={[]}
        serverSettings={settings}
        loading={false}
        locallyUpdatingProviders={new Set()}
        onUpdate={vi.fn()}
      />,
    );
    await expect.element(page.getByText("Update status not yet confirmed")).toBeVisible();
    expect(page.getByRole("button", { name: "Update Cursor CLI" }).query()).toBeNull();
  });

  it("renders confirmed, manual-only, and updating route states independently", async () => {
    const onUpdate = vi.fn();
    const view = await render(
      <ProviderUpdatesSettingsRow
        providers={[status("cursor")]}
        hiddenProviders={[]}
        serverSettings={settings}
        loading={false}
        locallyUpdatingProviders={new Set()}
        onUpdate={onUpdate}
      />,
    );
    await expect.element(page.getByText("1 update available")).toBeVisible();
    await page.getByRole("button", { name: "Update Cursor CLI" }).click();
    expect(onUpdate).toHaveBeenCalledOnce();

    await view.rerender(
      <ProviderUpdatesSettingsRow
        providers={[
          status("pi", {
            versionAdvisory: {
              ...status("pi").versionAdvisory!,
              updateCommand: null,
              canUpdate: false,
            },
          }),
        ]}
        hiddenProviders={[]}
        serverSettings={settings}
        loading={false}
        locallyUpdatingProviders={new Set()}
        onUpdate={vi.fn()}
      />,
    );
    await expect.element(page.getByText("Manual update")).toBeVisible();
    expect(page.getByRole("button", { name: "Update Pi CLI" }).query()).toBeNull();

    await view.rerender(
      <ProviderUpdatesSettingsRow
        providers={[
          status("antigravity", {
            updateState: {
              status: "running",
              startedAt: "2026-07-26T09:02:00.000Z",
              finishedAt: null,
              message: "Updating provider.",
              output: null,
            },
            versionAdvisory: {
              ...status("antigravity").versionAdvisory!,
              status: "unknown",
              latestVersion: null,
              updateCommand: null,
              canUpdate: false,
            },
          }),
        ]}
        hiddenProviders={[]}
        serverSettings={settings}
        loading={false}
        locallyUpdatingProviders={new Set()}
        onUpdate={vi.fn()}
      />,
    );
    await expect.element(page.getByText("1 update in progress")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Updating Antigravity CLI" }))
      .toBeDisabled();
  });
});
