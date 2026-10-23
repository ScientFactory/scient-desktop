import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { useEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

const voiceLifecycle = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }));
vi.mock("~/scient/voice/ScientVoiceCommentControl", () => ({
  ScientVoiceCommentControl: ({
    onBusyChange,
    onTranscript,
  }: {
    onBusyChange?: (busy: boolean) => void;
    onTranscript: (text: string) => void;
  }) => {
    useEffect(() => {
      voiceLifecycle.mount();
      return () => voiceLifecycle.unmount();
    }, []);
    return (
      <>
        <button
          type="button"
          aria-label="Dictate citation comment"
          onClick={() => onTranscript("Dictated context")}
        />
        <button type="button" onClick={() => onBusyChange?.(true)}>
          Begin voice processing
        </button>
        <button
          type="button"
          onClick={() => {
            onTranscript("Dictated context");
            onBusyChange?.(false);
          }}
        >
          Finish voice processing
        </button>
      </>
    );
  },
}));

import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";

const onSubmit = vi.fn(() => true);
const onSubmitAndSend = vi.fn(() => true);
const onCancel = vi.fn();
const onDraftChange = vi.fn();

async function render(
  _fixture: _Fixture,
  mode: "create" | "edit" = "edit",
  options: { withSubmitAndSend?: boolean } = {},
) {
  await act(
    async () =>
      await _fixture.root0.rerender(
        <AssistantCitationCommentEditor
          citation={{ environmentId: EnvironmentId.make("local") }}
          mode={mode}
          onSubmit={onSubmit}
          {...(options.withSubmitAndSend ? { onSubmitAndSend } : {})}
          onCancel={onCancel}
          onDraftChange={onDraftChange}
        />,
      ),
  );
}

async function click(_fixture: _Fixture, label: string) {
  const button = [..._fixture.container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(button, label).toBeDefined();
  await act(() => button!.click());
}

async function pressEnter(_fixture: _Fixture, options: KeyboardEventInit = {}) {
  const textarea = _fixture.container.querySelector<HTMLTextAreaElement>("textarea");
  expect(textarea).not.toBeNull();
  await act(() =>
    textarea!.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        ...options,
      }),
    ),
  );
}

async function _setupFixture0(_fixture: _Fixture) {
  vi.clearAllMocks();
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

describe("assistant citation comment actions", () => {
  it("keeps one voice controller in the right-side footer while idle actions hide and restore", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, "create");
    const footer = _fixture.container.querySelector('[data-citation-comment-footer="true"]');
    expect(footer?.className).toContain("justify-end");
    expect(footer?.querySelector('[aria-label="Dictate citation comment"]')).not.toBeNull();
    const save = [..._fixture.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Add to chat",
    )!;
    const idleActions = save.parentElement!;
    await click(_fixture, "Begin voice processing");
    expect(idleActions.className).toBe("hidden");
    expect(idleActions.hasAttribute("inert")).toBe(true);
    await click(_fixture, "Finish voice processing");
    expect(idleActions.className).not.toContain("hidden");
    expect(idleActions.hasAttribute("inert")).toBe(false);
    expect(voiceLifecycle.mount).toHaveBeenCalledOnce();
    expect(voiceLifecycle.unmount).not.toHaveBeenCalled();
  });
  it("saves when editing an existing citation comment", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    expect(_fixture.container.textContent).toContain("Save");
    expect(_fixture.container.textContent).not.toContain("Add to chat");

    await click(_fixture, "Save");

    expect(onSubmit).toHaveBeenCalledWith("");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("adds a new citation to chat with or without a comment", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, "create");
    expect(_fixture.container.textContent).toContain("Add to chat");
    expect(_fixture.container.textContent).not.toContain("Save");

    await click(_fixture, "Add to chat");

    expect(onSubmit).toHaveBeenCalledWith("");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps cancel separate from the primary action", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, "create");
    await click(_fixture, "Cancel");

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("inserts voice text into the optional comment without submitting it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, "create");
    const microphone = _fixture.container.querySelector<HTMLButtonElement>(
      '[aria-label="Dictate citation comment"]',
    );
    expect(microphone).not.toBeNull();
    await act(() => microphone!.click());

    expect(_fixture.container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "Dictated context",
    );
    expect(onDraftChange).toHaveBeenCalledWith("Dictated context");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    { shortcut: "Enter", options: {}, expected: onSubmit },
    { shortcut: "Command+Enter", options: { metaKey: true }, expected: onSubmitAndSend },
    { shortcut: "Ctrl+Enter", options: { ctrlKey: true }, expected: onSubmitAndSend },
  ])(
    "blocks $shortcut while voice processing is pending, then submits the transcript",
    async ({ options, expected }) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      await render(_fixture, "create", { withSubmitAndSend: true });
      await click(_fixture, "Begin voice processing");

      await pressEnter(_fixture, options);

      expect(onSubmit).not.toHaveBeenCalled();
      expect(onSubmitAndSend).not.toHaveBeenCalled();

      await click(_fixture, "Finish voice processing");
      expect(_fixture.container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
        "Dictated context",
      );

      await pressEnter(_fixture, options);

      expect(expected).toHaveBeenCalledWith("Dictated context");
    },
  );
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
