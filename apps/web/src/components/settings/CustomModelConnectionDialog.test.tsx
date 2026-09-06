// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  ProviderInstanceId,
  type CustomModelConnection,
  type CustomModelSaveInput,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CustomModelConnectionDialog } from "./CustomModelConnectionDialog";

const animationsDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
const connection: CustomModelConnection = {
  id: "shared",
  name: "Shared connection",
  protocol: "openai-completions",
  baseUrl: "https://example.test/v1",
  credentialId: "opaque-reference",
  apiKeySuffix: "abcd",
  models: ["one", "two"].map((id) => ({
    id,
    modelId: id,
    name: id,
    contextWindow: 32000,
    maxOutputTokens: 1024,
    images: false,
    reasoning: false,
    instanceIds: [ProviderInstanceId.make("pi")],
  })),
};

describe("connection management", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => [],
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    if (animationsDescriptor)
      Object.defineProperty(Element.prototype, "getAnimations", animationsDescriptor);
    else Reflect.deleteProperty(Element.prototype, "getAnimations");
    vi.unstubAllGlobals();
  });
  async function render(fail = false) {
    const onSave = vi.fn(async (_input: CustomModelSaveInput) => {
      if (fail) throw new Error("Custom models changed. Reload and try again.");
    });
    const onClose = vi.fn();
    await act(() =>
      root.render(
        <CustomModelConnectionDialog
          connection={connection}
          revision={7}
          onSave={onSave}
          onClose={onClose}
          onDelete={vi.fn()}
        />,
      ),
    );
    return { onSave, onClose };
  }
  async function change(selector: string, value: string) {
    const input = document.querySelector<HTMLInputElement>(selector)!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function submit() {
    await act(async () => {
      document
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }
  it("renames without replacing the shared key or dropping models", async () => {
    const callbacks = await render();
    await change('input:not([type="password"]):not([type="checkbox"])', "Renamed");
    await submit();
    expect(callbacks.onSave).toHaveBeenCalledExactlyOnceWith({
      revision: 7,
      connection: {
        id: connection.id,
        name: "Renamed",
        protocol: connection.protocol,
        baseUrl: connection.baseUrl,
        models: connection.models,
      },
    });
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });
  it("sends replacement keys redacted and clears the draft after success", async () => {
    const callbacks = await render();
    await change('input[type="password"]', "synthetic-replacement-key");
    await submit();
    const saved = callbacks.onSave.mock.calls[0]![0];
    expect(Redacted.value(saved.apiKey!)).toBe("synthetic-replacement-key");
    expect(saved.connection.models).toEqual(connection.models);
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  });
  it("removes the key explicitly without also submitting a replacement", async () => {
    const callbacks = await render();
    await change('input[type="password"]', "draft-key");
    await act(() => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await submit();
    const saved = callbacks.onSave.mock.calls[0]![0];
    expect(saved.removeKey).toBe(true);
    expect(saved).not.toHaveProperty("apiKey");
    expect(saved.connection.models).toEqual(connection.models);
  });
  it("keeps stale-revision failures open without claiming success", async () => {
    const callbacks = await render(true);
    await submit();
    expect(callbacks.onSave.mock.calls[0]![0].revision).toBe(7);
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Reload and try again");
  });
});
