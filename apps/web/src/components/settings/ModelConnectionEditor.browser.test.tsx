import { render as _fixtureRender, type Screen, act, fakeTimers } from "../../../test/render";
import "../../index.css";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type CustomModelSaveInput,
} from "@t3tools/contracts";

import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

import { ModelConnectionEditor } from "./ModelConnectionEditor";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
}

const droid = ProviderInstanceId.make("droid");

it("adds a local endpoint model: its required limits are visible and submit", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const onSave = vi.fn(async (_input: CustomModelSaveInput) => {});
  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(
    <ModelConnectionEditor
      settings={{ revision: 4, connections: [] }}
      target={{}}
      agents={[{ id: droid, name: "Droid", driver: ProviderDriverKind.make("droid") }]}
      defaultInstanceIds={[droid]}
      onSave={onSave}
      onClose={() => {}}
    />,
  );

  await userEvent.selectOptions(
    page.getByRole("combobox", { name: "Model provider" }),
    "Local / custom endpoint",
  );
  await userEvent.fill(page.getByRole("textbox", { name: "Base URL" }), "http://127.0.0.1:8080/v1");
  await userEvent.fill(page.getByRole("textbox", { name: "Model ID" }), "local-model");

  // A new custom endpoint needs manual limits; they must be reachable, not in a closed panel.
  const contextWindow = page.getByRole("spinbutton", { name: "Context window" });
  const maxOutput = page.getByRole("spinbutton", { name: "Max output tokens" });
  await expect.element(contextWindow).toBeVisible();
  await expect.element(maxOutput).toBeVisible();
  await userEvent.fill(contextWindow, "32768");
  await userEvent.fill(maxOutput, "4096");

  await userEvent.click(page.getByRole("button", { name: "Save model" }));
  await expect.poll(() => onSave.mock.calls.length).toBe(1);
  const input = onSave.mock.calls[0]![0];
  expect(input.revision).toBe(4);
  expect(input.connection).toMatchObject({
    baseUrl: "http://127.0.0.1:8080/v1",
    protocol: "openai-completions",
  });
  expect(input.connection.models[0]).toMatchObject({
    modelId: "local-model",
    configurationMode: "manual",
    contextWindow: 32768,
    maxOutputTokens: 4096,
    instanceIds: [droid],
  });
});

it("keeps invalid manual limits in view instead of silently refusing to save", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const onSave = vi.fn(async (_input: CustomModelSaveInput) => {});
  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(
    <ModelConnectionEditor
      settings={{ revision: 4, connections: [] }}
      target={{}}
      agents={[{ id: droid, name: "Droid", driver: ProviderDriverKind.make("droid") }]}
      defaultInstanceIds={[droid]}
      onSave={onSave}
      onClose={() => {}}
    />,
  );
  await userEvent.selectOptions(
    page.getByRole("combobox", { name: "Model provider" }),
    "Local / custom endpoint",
  );
  await userEvent.fill(page.getByRole("textbox", { name: "Base URL" }), "http://127.0.0.1:8080/v1");
  await userEvent.fill(page.getByRole("textbox", { name: "Model ID" }), "local-model");
  const contextWindow = page.getByRole("spinbutton", { name: "Context window" });
  // Both limits are filled, but the context window is below the minimum (1024).
  const clock = _fixture.stack.use(fakeTimers());
  await userEvent.fill(contextWindow, "512");
  await userEvent.fill(page.getByRole("spinbutton", { name: "Max output tokens" }), "4096");
  // Longer than the panel's collapse animation: Advanced must not close on the user.
  await act(() => vi.advanceTimersByTimeAsync(500));
  clock[Symbol.dispose]();
  await expect
    .element(page.getByRole("button", { name: "Advanced", exact: true }))
    .toHaveAttribute("aria-expanded", "true");
  await expect.element(contextWindow).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Save model" }));
  // The browser can point at the field: it is visible, invalid and focused.
  await expect.element(contextWindow).toBeVisible();
  await expect.element(contextWindow).toBeInvalid();
  await expect.element(contextWindow).toHaveFocus();
  expect(onSave).not.toHaveBeenCalled();

  await userEvent.fill(contextWindow, "32768");
  await userEvent.click(page.getByRole("button", { name: "Save model" }));
  await expect.poll(() => onSave.mock.calls.length).toBe(1);
  expect(onSave.mock.calls[0]![0].connection.models[0]).toMatchObject({
    contextWindow: 32768,
    maxOutputTokens: 4096,
  });
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
