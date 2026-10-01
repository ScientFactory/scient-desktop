import "../../index.css";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

import {
  CustomModelRowActions,
  CustomModelTestGuidance,
  type CustomModelTestNotice,
} from "./CustomModelRowActions";
import { MISSING_KEY_STATUS } from "./customModels";

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

const pi = { id: ProviderInstanceId.make("pi"), name: "Pi" };
const droid = { id: ProviderInstanceId.make("droid"), name: "Droid" };

function render(
  props: {
    testAgents?: ReadonlyArray<typeof pi>;
    statuses?: ReadonlyArray<string | undefined>;
    keyMissing?: boolean;
    notice?: CustomModelTestNotice | null;
  } = {},
) {
  const onTest = vi.fn();
  const onCheckAgain = vi.fn();
  const onReenterKey = vi.fn();
  host = document.createElement("div");
  host.className = "flex items-center gap-2";
  document.body.append(host);
  root = createRoot(host);
  root.render(
    <CustomModelRowActions
      busy={false}
      testing={false}
      statuses={props.statuses ?? []}
      keyMissing={props.keyMissing ?? false}
      testAgents={props.testAgents ?? [pi, droid]}
      notice={props.notice ?? null}
      onCheckAgain={onCheckAgain}
      onReenterKey={onReenterKey}
      onTest={onTest}
    />,
  );
  return { onTest, onCheckAgain, onReenterKey };
}

it("opens the agent menu for a model attached to several agents and tests through the choice", async () => {
  const { onTest } = render();
  await userEvent.click(page.getByRole("button", { name: "Test" }));
  await expect.element(page.getByRole("menuitem", { name: "Pi" })).toBeVisible();
  await expect.element(page.getByText("API charges may apply.")).toBeVisible();
  await userEvent.click(page.getByRole("menuitem", { name: "Droid" }));
  expect(onTest).toHaveBeenCalledExactlyOnceWith(droid.id);
});

it("offers Re-enter key when the key is missing and the agent reporting it is signed out", async () => {
  // The row's only label is the agent's own problem; the key is still missing.
  const { onReenterKey, onCheckAgain } = render({ statuses: ["Check agent"], keyMissing: true });
  await userEvent.click(page.getByRole("button", { name: "Re-enter key" }));
  expect(onReenterKey).toHaveBeenCalledOnce();
  await userEvent.click(page.getByRole("button", { name: "Check again" }));
  expect(onCheckAgain).toHaveBeenCalledOnce();
});

it("offers Re-enter key for a missing key even when another agent needs a recheck", async () => {
  const { onReenterKey, onCheckAgain } = render({
    statuses: [MISSING_KEY_STATUS, "Check agent"],
    keyMissing: true,
  });
  await userEvent.click(page.getByRole("button", { name: "Re-enter key" }));
  expect(onReenterKey).toHaveBeenCalledOnce();
  await userEvent.click(page.getByRole("button", { name: "Check again" }));
  expect(onCheckAgain).toHaveBeenCalledOnce();
});

it("keeps the agent choice after a failed Test", async () => {
  const { onTest } = render({
    notice: { text: "Pi: No response within 45 s.", error: true, agent: pi.id },
  });
  // The failure stays visible and can be retried through the same agent...
  await userEvent.click(page.getByRole("button", { name: /Test failed/ }));
  expect(onTest).toHaveBeenLastCalledWith(pi.id);
  // ...and the other agent can still be chosen.
  await userEvent.click(page.getByRole("button", { name: "Test", exact: true }));
  await userEvent.click(page.getByRole("menuitem", { name: "Droid" }));
  expect(onTest).toHaveBeenLastCalledWith(droid.id);
});

it("retries a failed Test of a single-agent model through that agent", async () => {
  const { onTest } = render({
    testAgents: [droid],
    notice: { text: "Droid: 401 Incorrect API key provided", error: true, agent: droid.id },
  });
  await userEvent.click(page.getByRole("button", { name: /Test failed/ }));
  expect(onTest).toHaveBeenCalledExactlyOnceWith(droid.id);
  expect(document.querySelectorAll("button")).toHaveLength(1);
});

it("tests through the only agent directly", async () => {
  const { onTest } = render({ testAgents: [droid] });
  await userEvent.click(page.getByRole("button", { name: "Test" }));
  expect(onTest).toHaveBeenCalledExactlyOnceWith(droid.id);
});

it("says how to make the model testable when no enabled agent can run a Test", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(<CustomModelTestGuidance testAgents={[]} agents={[pi, droid]} />);
  await expect
    .element(
      page.getByText(
        "To test this model, select an enabled agent under Use with (Edit): Pi or Droid.",
      ),
    )
    .toBeVisible();
  root.render(<CustomModelTestGuidance testAgents={[droid]} agents={[pi, droid]} />);
  await expect.poll(() => host?.textContent).toBe("");
});
