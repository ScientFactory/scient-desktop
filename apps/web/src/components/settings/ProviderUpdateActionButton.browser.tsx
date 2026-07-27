// FILE: ProviderUpdateActionButton.browser.tsx
// Purpose: Browser-level regressions for truthful provider CLI update actions.
// Layer: Vitest browser tests

import "../../index.css";

import type { ProviderKind, ServerProviderStatus } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ProviderUpdateActionButton } from "./ProviderUpdateActionButton";

function providerStatus(
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

describe("ProviderUpdateActionButton", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("offers a keyboard-accessible action for a confirmed outdated CLI", async () => {
    const onUpdate = vi.fn();
    await render(
      <ProviderUpdateActionButton
        providerStatus={providerStatus("cursor")}
        confirmedUpdateVisible
        onUpdate={onUpdate}
      />,
    );

    const update = page.getByRole("button", { name: "Update Cursor CLI" });
    await userEvent.tab();
    await expect.element(update).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("does not render Update for unknown Cursor or managed Antigravity checks", async () => {
    const unknownAdvisory = {
      ...providerStatus("cursor").versionAdvisory!,
      status: "unknown" as const,
      latestVersion: null,
    };
    const view = await render(
      <ProviderUpdateActionButton
        providerStatus={providerStatus("cursor", { versionAdvisory: unknownAdvisory })}
        confirmedUpdateVisible
        onUpdate={vi.fn()}
      />,
    );
    expect(page.getByRole("button", { name: "Update Cursor CLI" }).query()).toBeNull();

    await view.rerender(
      <ProviderUpdateActionButton
        providerStatus={providerStatus("antigravity", {
          runtime: {
            source: "managed",
            managedVersion: "1.1.4",
            canInstall: false,
            canRepair: true,
            canRollback: false,
            canRemove: true,
            message: null,
          },
          versionAdvisory: { ...unknownAdvisory, updateCommand: null, canUpdate: false },
        })}
        confirmedUpdateVisible
        onUpdate={vi.fn()}
      />,
    );
    expect(page.getByRole("button", { name: "Update Antigravity CLI" }).query()).toBeNull();
  });

  it("keeps an active update visible and disabled after advisory evidence disappears", async () => {
    const onUpdate = vi.fn();
    await render(
      <ProviderUpdateActionButton
        providerStatus={providerStatus("antigravity", {
          updateState: {
            status: "running",
            startedAt: "2026-07-26T09:01:00.000Z",
            finishedAt: null,
            message: "Updating provider.",
            output: null,
          },
          versionAdvisory: {
            ...providerStatus("antigravity").versionAdvisory!,
            status: "unknown",
            latestVersion: null,
          },
        })}
        confirmedUpdateVisible={false}
        onUpdate={onUpdate}
      />,
    );

    const updating = page.getByRole("button", { name: "Updating Antigravity CLI" });
    await expect.element(updating).toBeDisabled();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
