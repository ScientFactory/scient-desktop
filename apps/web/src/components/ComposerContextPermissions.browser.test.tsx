import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { ComposerContextPermissions } from "./ComposerContextPermissions";

vi.mock("../state/managedPolicy", () => ({
  useManagedPolicy: () => ({
    organization: "Example Corp",
    limits: { maxRuntimeMode: "auto-accept-edits" },
  }),
}));

describe("ComposerContextPermissions", () => {
  // regression: the new-thread strip built its own options, so a ceiling never reached this menu.
  it("disables modes above the administrator's ceiling", async () => {
    await using _screen = await render(
      <ComposerContextPermissions
        environmentId={EnvironmentId.make("environment-local")}
        runtimeMode="auto-accept-edits"
        supportedRuntimeModes={undefined}
        onRuntimeModeChange={() => undefined}
      />,
    );
    await page.getByRole("button", { name: "Permissions: Auto-accept edits" }).click();

    await expect
      .element(page.getByRole("menuitemradio", { name: "Full access" }))
      .toHaveAttribute("aria-disabled", "true");
    await expect
      .element(page.getByRole("menuitemradio", { name: "Supervised" }))
      .not.toHaveAttribute("aria-disabled", "true");
  });
});
