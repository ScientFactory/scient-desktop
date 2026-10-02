import "../../index.css";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type CustomModelSaveInput,
} from "@t3tools/contracts";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

import { ModelConnectionEditor } from "./ModelConnectionEditor";

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

const droid = ProviderInstanceId.make("droid");

it("adds a local endpoint model: its required limits are visible and submit", async () => {
  const onSave = vi.fn(async (_input: CustomModelSaveInput) => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(
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
  const onSave = vi.fn(async (_input: CustomModelSaveInput) => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(
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
  await userEvent.fill(contextWindow, "512");
  await userEvent.fill(page.getByRole("spinbutton", { name: "Max output tokens" }), "4096");
  // Longer than the panel's collapse animation: Advanced must not close on the user.
  await new Promise((resolve) => setTimeout(resolve, 500));
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
