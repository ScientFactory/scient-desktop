// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ProviderModelsSection } from "./ProviderModelsSection";
import { getDriverOption } from "./providerDriverMeta";

describe("provider-native model catalogs", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  async function render(driver: string) {
    const kind = ProviderDriverKind.make(driver);
    const onChange = vi.fn();
    const onFavoriteModelsChange = vi.fn();
    await act(() =>
      root.render(
        <ProviderModelsSection
          instanceId={ProviderInstanceId.make(driver)}
          driverKind={kind}
          supportsCustomModels={getDriverOption(kind)?.supportsCustomModels !== false}
          models={[
            { slug: "local/model", name: "Local model", isCustom: false, capabilities: null },
          ]}
          customModels={[]}
          hiddenModels={[]}
          favoriteModels={[]}
          modelOrder={[]}
          onChange={onChange}
          onFavoriteModelsChange={onFavoriteModelsChange}
          onHiddenModelsChange={vi.fn()}
          onModelOrderChange={vi.fn()}
        />,
      ),
    );
    return { onChange, onFavoriteModelsChange };
  }
  it.each(["pi", "antigravity"])(
    "keeps %s catalog curation without offering invented models",
    async (driver) => {
      const callbacks = await render(driver);
      expect(container.textContent).toContain("Local model");
      expect(container.textContent).not.toContain("Add custom model");
      const favorite = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Add Local model to favorites"]',
      );
      expect(favorite).not.toBeNull();
      await act(() => favorite!.click());
      expect(callbacks.onFavoriteModelsChange).toHaveBeenCalledWith(["local/model"]);
      expect(callbacks.onChange).not.toHaveBeenCalled();
    },
  );
  it("preserves custom-model entry for providers that support it", async () => {
    const callbacks = await render("opencode");
    const add = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Add custom model"),
    );
    expect(add).toBeDefined();
    await act(() => add!.click());
    const input = container.querySelector<HTMLInputElement>('input[id$="-custom-model"]')!;
    expect(input).not.toBeNull();
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "custom/model",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    expect(callbacks.onChange).toHaveBeenCalledWith([
      { slug: "custom/model", name: "custom/model", capabilities: null },
    ]);
    expect(container.querySelector('input[id$="-custom-model"]')).toBeNull();
  });
});
