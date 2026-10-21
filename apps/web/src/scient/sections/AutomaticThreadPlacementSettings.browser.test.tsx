import { render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import { expect, it } from "vite-plus/test";
import { page } from "vitest/browser";
import { AutomaticThreadPlacementSettings } from "./AutomaticThreadPlacementSettings";
import {
  AUTOMATIC_PLACEMENT_KEY,
  useAutomaticPlacementPreference,
} from "./automaticPlacementPreference";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  localStorage.removeItem(AUTOMATIC_PLACEMENT_KEY);
  useAutomaticPlacementPreference.setState({ enabled: true });
}
it("has an accessible persistent toggle and default reset", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  useAutomaticPlacementPreference.setState({ enabled: true });
  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(<AutomaticThreadPlacementSettings />);
  const toggle = page.getByRole("switch", { name: "Keep active threads near the top" });
  await expect.element(toggle).toHaveAttribute("aria-checked", "true");
  // This panel mounts while the sidebar is absent; old placement must not survive.
  localStorage.setItem("scient:sidebar:placement-order:settings-test", "old presentation");
  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-checked", "false");
  expect(localStorage.getItem(AUTOMATIC_PLACEMENT_KEY)).toBe("false");
  expect(localStorage.getItem("scient:sidebar:placement-order:settings-test")).toBeNull();
  await page.getByRole("button", { name: "Reset automatic thread placement to default" }).click();
  await expect.element(toggle).toHaveAttribute("aria-checked", "true");
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement | undefined,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
