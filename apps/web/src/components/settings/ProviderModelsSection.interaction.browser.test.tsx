import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { ProviderModelsSection } from "./ProviderModelsSection";
import { getDriverOption } from "./providerDriverMeta";

describe("provider-native model catalogs", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
    vi.unstubAllGlobals();
  }
  async function render(_fixture: _Fixture, driver: string, unavailableReason?: string) {
    const kind = ProviderDriverKind.make(driver);
    const onChange = vi.fn();
    const onFavoriteModelsChange = vi.fn();
    const onToggleFavorite = vi.fn();
    await act(
      async () =>
        await _fixture.root0.rerender(
          <ProviderModelsSection
            instanceId={ProviderInstanceId.make(driver)}
            driverKind={kind}
            canManageCustomModels
            supportsCustomModels={getDriverOption(kind)?.supportsCustomModels !== false}
            models={[
              {
                slug: "local/model",
                name: "Local model",
                isCustom: false,
                capabilities: null,
                ...(unavailableReason ? { unavailableReason } : {}),
              },
            ]}
            customModels={[]}
            hiddenModels={[]}
            favoriteModels={[]}
            modelOrder={[]}
            onChange={onChange}
            onFavoriteModelsChange={onFavoriteModelsChange}
            onToggleFavorite={onToggleFavorite}
            onHiddenModelsChange={vi.fn()}
            onModelOrderChange={vi.fn()}
          />,
        ),
    );
    return { onChange, onFavoriteModelsChange, onToggleFavorite };
  }
  // pi and antigravity share the supportsCustomModels: false branch.
  it("keeps pi catalog curation without offering invented models", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const callbacks = await render(_fixture, "pi");
    expect(_fixture.container.textContent).toContain("Local model");
    expect(_fixture.container.textContent).not.toContain("Add custom model");
    const favorite = _fixture.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add Local model to favorites"]',
    );
    expect(favorite).not.toBeNull();
    await act(() => favorite!.click());
    expect(callbacks.onToggleFavorite).toHaveBeenCalledWith("local/model");
    expect(callbacks.onFavoriteModelsChange).not.toHaveBeenCalled();
    expect(callbacks.onChange).not.toHaveBeenCalled();
  });
  // regression: 8b55e253a2 fix(models): exclude known unavailable models from selection
  it("keeps an unavailable model and its explanation on the provider page with picker visibility off", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, "omp", "Account access required.");
    expect(_fixture.container.textContent).toContain("Local model");
    expect(_fixture.container.textContent).toContain("Unavailable: Account access required.");
    const toggle = _fixture.container.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="Show Local model in the model picker"]',
    );
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(toggle?.hasAttribute("data-disabled")).toBe(true);
  });
  it("preserves custom-model entry for providers that support it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const callbacks = await render(_fixture, "opencode");
    const add = [..._fixture.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Add custom model"),
    );
    expect(add).toBeDefined();
    await act(() => add!.click());
    const input = _fixture.container.querySelector<HTMLInputElement>('input[id$="-custom-model"]')!;
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
    expect(_fixture.container.querySelector('input[id$="-custom-model"]')).toBeNull();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
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
