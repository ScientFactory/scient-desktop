import { render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import { ProviderInstanceId } from "@t3tools/contracts";

import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";

import {
  CustomModelRowActions,
  CustomModelTestGuidance,
  type CustomModelTestNotice,
} from "./CustomModelRowActions";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
}

const pi = { id: ProviderInstanceId.make("pi"), name: "Pi" };
const droid = { id: ProviderInstanceId.make("droid"), name: "Droid" };

async function render(
  _fixture: _Fixture,
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
  _fixture.host = document.createElement("div");
  _fixture.host.className = "flex items-center gap-2";
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(
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
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const { onTest } = await render(_fixture);
  await userEvent.click(page.getByRole("button", { name: "Test" }));
  await expect.element(page.getByRole("menuitem", { name: "Pi" })).toBeVisible();
  await expect.element(page.getByText("API charges may apply.")).toBeVisible();
  await userEvent.click(page.getByRole("menuitem", { name: "Droid" }));
  expect(onTest).toHaveBeenCalledExactlyOnceWith(droid.id);
});

it("offers Re-enter key when the key is missing and the agent reporting it is signed out", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  // The row's only label is the agent's own problem; the key is still missing.
  const { onReenterKey, onCheckAgain } = await render(_fixture, {
    statuses: ["Check agent"],
    keyMissing: true,
  });
  await userEvent.click(page.getByRole("button", { name: "Re-enter key" }));
  expect(onReenterKey).toHaveBeenCalledOnce();
  await userEvent.click(page.getByRole("button", { name: "Check again" }));
  expect(onCheckAgain).toHaveBeenCalledOnce();
});

// regression: e2fc205c51 feat(droid): custom models and setup say what will happen, and document it
it("says how to make the model testable when no enabled agent can run a Test", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(<CustomModelTestGuidance testAgents={[]} agents={[pi, droid]} />);
  await expect
    .element(
      page.getByText(
        "To test this model, select an enabled agent under Use with (Edit): Pi or Droid.",
      ),
    )
    .toBeVisible();
  await _fixture.root0.rerender(
    <CustomModelTestGuidance testAgents={[droid]} agents={[pi, droid]} />,
  );
  await expect.poll(() => _fixture.host?.textContent).toBe("");
});

it("keeps the agent choice after a failed Test", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const { onTest } = await render(_fixture, {
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
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const { onTest } = await render(_fixture, {
    testAgents: [droid],
    notice: { text: "Droid: 401 Incorrect API key provided", error: true, agent: droid.id },
  });
  await userEvent.click(page.getByRole("button", { name: /Test failed/ }));
  expect(onTest).toHaveBeenCalledExactlyOnceWith(droid.id);
  expect(document.querySelectorAll("button")).toHaveLength(1);
});

it("tests through the only agent directly", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const { onTest } = await render(_fixture, { testAgents: [droid] });
  await userEvent.click(page.getByRole("button", { name: "Test" }));
  expect(onTest).toHaveBeenCalledExactlyOnceWith(droid.id);
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
