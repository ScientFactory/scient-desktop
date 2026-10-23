import "../../index.css";
import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import {
  ProviderInstanceId,
  type CustomModelConnection,
  type CustomModelSaveInput,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { describe, expect, it, vi } from "vite-plus/test";
import { CustomModelConnectionDialog } from "./CustomModelConnectionDialog";

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
  }
  async function render(_fixture: _Fixture, fail = false, keyMissing = false) {
    const onSave = vi.fn(async (_input: CustomModelSaveInput) => {
      if (fail) throw new Error("Custom models changed. Reload and try again.");
    });
    const onClose = vi.fn();
    await act(
      async () =>
        await _fixture.root0.rerender(
          <CustomModelConnectionDialog
            connection={connection}
            revision={7}
            onSave={onSave}
            onClose={onClose}
            onDelete={vi.fn()}
            keyMissing={keyMissing}
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const callbacks = await render(_fixture);
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const callbacks = await render(_fixture);
    await change('input[type="password"]', "synthetic-replacement-key");
    await submit();
    const saved = callbacks.onSave.mock.calls[0]![0];
    expect(Redacted.value(saved.apiKey!)).toBe("synthetic-replacement-key");
    expect(saved.connection.models).toEqual(connection.models);
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  });
  it("removes the key explicitly without also submitting a replacement", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const callbacks = await render(_fixture);
    await change('input[type="password"]', "draft-key");
    await act(() => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await submit();
    const saved = callbacks.onSave.mock.calls[0]![0];
    expect(saved.removeKey).toBe(true);
    expect(saved).not.toHaveProperty("apiKey");
    expect(saved.connection.models).toEqual(connection.models);
  });
  it("keeps stale-revision failures open without claiming success", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const callbacks = await render(_fixture, true);
    await submit();
    expect(callbacks.onSave.mock.calls[0]![0].revision).toBe(7);
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Reload and try again");
  });
  it("says a saved key is missing and asks for it again instead of showing its last four", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, false, true);
    expect(document.body.textContent).toContain("Saved key missing — re-enter it");
    expect(document.body.textContent).not.toContain("Key ending in");
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
