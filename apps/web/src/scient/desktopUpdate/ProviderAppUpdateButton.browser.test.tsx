import { RegistryProvider } from "@effect/atom-react";
import { EnvironmentId, type DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { ConfirmDialogHost } from "~/components/ConfirmDialogHost";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { render, stubGlobal } from "../../../test/render";
import "../../index.css";
import { ProviderAppUpdateButton } from "./ProviderAppUpdateButton";

const primary = EnvironmentId.make("primary");

const downloaded: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  channel: "latest",
  currentVersion: "0.6.33",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "0.6.34",
  downloadedVersion: "0.6.34",
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: 100,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: true,
};

describe("ProviderAppUpdateButton", () => {
  it("asks for confirmation above provider setup before restarting", async () => {
    const installUpdate = vi.fn(async () => ({
      accepted: true,
      completed: true,
      state: downloaded,
    }));
    using _bridge = stubGlobal("desktopBridge", {
      getUpdateState: async () => downloaded,
      onUpdateState: () => () => {},
      checkForUpdate: vi.fn(),
      installUpdate,
    });
    await using _screen = await render(
      <RegistryProvider initialValues={[[primaryEnvironmentIdAtom, primary]]}>
        <ConfirmDialogHost />
        <Dialog open>
          <DialogPopup>
            <DialogTitle>Provider setup</DialogTitle>
            <ProviderAppUpdateButton environmentId={primary} requiresAppUpdate />
          </DialogPopup>
        </Dialog>
      </RegistryProvider>,
    );

    await page.getByRole("button", { name: "Update Scient" }).click();
    const confirmation = page.getByRole("alertdialog", { name: /restart Scient/ });
    await expect.element(confirmation).toBeVisible();
    expect(installUpdate).not.toHaveBeenCalled();

    await confirmation.getByRole("button", { name: "Confirm" }).click();
    expect(installUpdate).toHaveBeenCalledWith(downloaded.downloadedVersion);
  });

  it("omits the local desktop update for a linked environment's provider", async () => {
    using _bridge = stubGlobal("desktopBridge", {
      getUpdateState: async () => downloaded,
      onUpdateState: () => () => {},
      checkForUpdate: vi.fn(),
    });
    await using screen = await render(
      <RegistryProvider initialValues={[[primaryEnvironmentIdAtom, primary]]}>
        <ProviderAppUpdateButton environmentId={EnvironmentId.make("linked")} requiresAppUpdate />
      </RegistryProvider>,
    );

    await expect
      .element(screen.getByRole("button", { name: "Update Scient" }))
      .not.toBeInTheDocument();
  });

  it("omits the action in a browser even when the provider needs a newer app", async () => {
    using _bridge = stubGlobal("desktopBridge", undefined);
    await using screen = await render(
      <RegistryProvider initialValues={[[primaryEnvironmentIdAtom, primary]]}>
        <ProviderAppUpdateButton environmentId={primary} requiresAppUpdate />
      </RegistryProvider>,
    );

    await expect
      .element(screen.getByRole("button", { name: "Update Scient" }))
      .not.toBeInTheDocument();
  });
});
