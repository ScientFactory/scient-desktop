import { render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ readProviders: vi.fn(), toasts: vi.fn() }));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/state/environments", () => ({
  useEnvironments: state.readProviders,
  useEnvironmentProviders: state.readProviders,
  usePrimaryEnvironmentId: state.readProviders,
}));
vi.mock("~/components/ProviderUpdatesAction", () => ({ useProviderUpdates: state.readProviders }));
vi.mock("./useManagedRuntimeUpdates", () => ({
  connectedProviderEnvironments: state.readProviders,
  useManagedRuntimeUpdates: state.readProviders,
}));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (options: object) => options,
  toastManager: { add: state.toasts },
}));

import { BrowserProviderUpdateNotification } from "./BrowserProviderUpdateNotification";

it("leaves desktop availability to the circle without mounting browser update owners", async () => {
  state.readProviders.mockReset();
  state.toasts.mockReset();
  await using screen = await render(<BrowserProviderUpdateNotification />);
  expect(screen.container.textContent).toBe("");
  expect(state.readProviders).not.toHaveBeenCalled();
  expect(state.toasts).not.toHaveBeenCalled();
});
