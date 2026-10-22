import { render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import { useState } from "react";

import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import type { EnvironmentId } from "@t3tools/contracts";
import { NewSectionPopover, type SectionCreateAnchor } from "./NewSectionPopover";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
}
async function openForm() {
  await userEvent.click(document.querySelector("button")!);
  await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Section name"]');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });
}

const MACHINES = [
  { environmentId: "laptop" as EnvironmentId, label: "Laptop" },
  { environmentId: "lab" as EnvironmentId, label: "Lab server" },
];

async function renderForm(
  _fixture: _Fixture,
  submit: (name: string) => Promise<boolean>,
  native = false,
  onMachine?: (environmentId: EnvironmentId) => void,
) {
  function Probe() {
    const [open, setOpen] = useState(false);
    const [anchor, setAnchor] = useState<SectionCreateAnchor | null>(null);
    const [machine, setMachine] = useState<EnvironmentId | null>(MACHINES[1]!.environmentId);
    return (
      <>
        <button
          style={{ position: "absolute", left: 32, top: 80, width: 100, height: 32 }}
          onClick={(event) => {
            setAnchor(native ? { x: 132, y: 80 } : event.currentTarget);
            setOpen(true);
          }}
        >
          New section
        </button>
        <button style={{ position: "absolute", left: 32, top: 260 }} data-testid="outside">
          Outside
        </button>
        <NewSectionPopover
          open={open}
          anchor={anchor}
          requestKey={1}
          threadCount={onMachine ? 0 : 1}
          environmentPicker={
            onMachine
              ? {
                  choices: MACHINES,
                  value: machine,
                  onChange: (environmentId) => {
                    setMachine(environmentId);
                    onMachine(environmentId);
                  },
                }
              : null
          }
          onOpenChange={setOpen}
          onSubmit={submit}
        />
      </>
    );
  }
  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(<Probe />);
}

it.each([false, true])(
  "opens a compact nonmodal form beside its element or native-menu origin (%s)",
  async (native) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const submit = vi.fn(async () => true);
    await renderForm(_fixture, submit, native);
    await openForm();
    const popup = document.querySelector<HTMLElement>('[data-slot="popover-popup"]')!;
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Section name"]')!;
    await vi.waitFor(() => {
      const rect = popup.getBoundingClientRect();
      expect(rect.width).toBeLessThanOrEqual(260);
      expect(rect.height).toBeLessThan(180);
      expect(rect.left).toBeGreaterThanOrEqual(130);
      // A point anchor aligns with the transform origin, which Base UI insets
      // from the rounded corner. An element anchor aligns with the popup's top.
      const originOffset = native
        ? Number.parseFloat(getComputedStyle(popup).transformOrigin.split(" ")[1]!)
        : 0;
      expect(Math.abs(rect.top + originOffset - 80)).toBeLessThan(1);
    });
    expect(document.querySelector('[data-slot="dialog-backdrop"]')).toBeNull();
    expect(document.activeElement).toBe(input);
    await userEvent.keyboard("research");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith("Research"));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull(),
    );
  },
);

it("dismisses by outside click without submitting", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const submit = vi.fn(async () => true);
  await renderForm(_fixture, submit);
  await openForm();
  await userEvent.keyboard("draft");
  await userEvent.click(document.querySelector('[data-testid="outside"]')!);
  expect(submit).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull());
});

it("names the machine an empty section goes to, and keeps the form open while choosing", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const submit = vi.fn(async () => true);
  const onMachine = vi.fn();
  await renderForm(_fixture, submit, false, onMachine);
  await openForm();
  const trigger = document.querySelector<HTMLElement>('[aria-label="Machine"]')!;
  expect(trigger.textContent).toContain("On Lab server");
  await userEvent.click(trigger);
  const laptop = await vi.waitFor(() => {
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (node) => node.textContent === "Laptop",
    );
    expect(option).toBeDefined();
    return option!;
  });
  await userEvent.click(laptop);
  await vi.waitFor(() => expect(onMachine).toHaveBeenCalledExactlyOnceWith("laptop"));
  // Choosing inside the nested list does not dismiss the form.
  expect(document.querySelector('[data-slot="popover-popup"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Machine"]')!.textContent).toContain("On Laptop");
  await userEvent.click(document.querySelector<HTMLInputElement>("input")!);
  await userEvent.keyboard("later");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith("Later"));
});

it("keeps a failed name for retry and closes with Escape", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const submit = vi.fn(async () => false);
  await renderForm(_fixture, submit);
  await openForm();
  await userEvent.keyboard("design");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => {
    expect(document.querySelector("input")?.value).toBe("Design");
    expect(document.body.textContent).toContain("could not be saved");
  });
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull());
  expect(document.activeElement).toBe(document.querySelector("button"));
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
