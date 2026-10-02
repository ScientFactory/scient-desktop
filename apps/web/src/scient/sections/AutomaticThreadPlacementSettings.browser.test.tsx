import "../../index.css";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vite-plus/test";
import { page } from "vitest/browser";
import { AutomaticThreadPlacementSettings } from "./AutomaticThreadPlacementSettings";
import {
  AUTOMATIC_PLACEMENT_KEY,
  useAutomaticPlacementPreference,
} from "./automaticPlacementPreference";
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  root?.unmount();
  host?.remove();
  localStorage.removeItem(AUTOMATIC_PLACEMENT_KEY);
  useAutomaticPlacementPreference.setState({ enabled: true });
});
it("has an accessible persistent toggle and default reset", async () => {
  useAutomaticPlacementPreference.setState({ enabled: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(<AutomaticThreadPlacementSettings />);
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
