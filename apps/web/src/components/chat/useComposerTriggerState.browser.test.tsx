import { StrictMode, useLayoutEffect } from "react";
import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { detectComposerTrigger } from "../../composer-logic";
import { useComposerTriggerState } from "./useComposerTriggerState";

const command = "pnpm install -g @openai/codex@latest";
const initialPrompt = "pnpm install -g @openai";

function ComposerProbe({ _fixture }: { _fixture: _Fixture }) {
  const state = useComposerTriggerState(() =>
    detectComposerTrigger(initialPrompt, initialPrompt.length),
  );
  useLayoutEffect(() => {
    _fixture.publishComposer(state);
  });
  return null;
}

async function updatePrompt(_fixture: _Fixture, text: string, cursor = text.length) {
  await act(() => _fixture.composer.setTrigger(detectComposerTrigger(text, cursor)));
}

const renderComposer = (_fixture: _Fixture) =>
  render(
    <StrictMode>
      <ComposerProbe _fixture={_fixture} />
    </StrictMode>,
  );

describe("composer suggestion dismissal", () => {
  it("closes suggestions and rejects keyboard selection before the next render", async () => {
    await using _fixture = _createFixture();

    await using _screen = await renderComposer(_fixture);
    const candidate = detectComposerTrigger(initialPrompt, initialPrompt.length);
    expect(_fixture.composer.trigger).toEqual(candidate);

    await act(() => {
      _fixture.composer.dismissTrigger(candidate);
      expect(_fixture.composer.resolveTrigger(candidate)).toBeNull();
    });
    expect(_fixture.composer.trigger).toBeNull();
  });

  it("stays dismissed while typing a scoped package, including its second @", async () => {
    await using _fixture = _createFixture();

    await using _screen = await renderComposer(_fixture);
    await act(() => _fixture.composer.dismissTrigger(_fixture.composer.trigger));

    for (let cursor = initialPrompt.length; cursor <= command.length; cursor += 1) {
      const text = command.slice(0, cursor);
      await updatePrompt(_fixture, text);
      expect(_fixture.composer.trigger).toBeNull();
      expect(_fixture.composer.resolveTrigger(detectComposerTrigger(text, cursor))).toBeNull();
    }
  });

  it("stays dismissed while deleting characters or moving within the same word", async () => {
    await using _fixture = _createFixture();

    await using _screen = await renderComposer(_fixture);
    await act(() => _fixture.composer.dismissTrigger(_fixture.composer.trigger));

    for (let cursor = initialPrompt.length - 1; cursor > initialPrompt.indexOf("@"); cursor -= 1) {
      await updatePrompt(_fixture, initialPrompt, cursor);
      expect(_fixture.composer.trigger).toBeNull();
      await updatePrompt(_fixture, initialPrompt.slice(0, cursor));
      expect(_fixture.composer.trigger).toBeNull();
    }
  });

  it("opens suggestions for a new @ word after a space", async () => {
    await using _fixture = _createFixture();

    await using _screen = await renderComposer(_fixture);
    await act(() => _fixture.composer.dismissTrigger(_fixture.composer.trigger));
    await updatePrompt(_fixture, `${command} `);
    await updatePrompt(_fixture, `${command} @src`);

    expect(_fixture.composer.trigger?.query).toBe("src");
    expect(_fixture.composer.trigger?.rangeStart).toBe(command.length + 1);
  });

  it("opens a different token when the caret moves directly to it", async () => {
    await using _fixture = _createFixture();

    await using _screen = await renderComposer(_fixture);
    await act(() => _fixture.composer.dismissTrigger(_fixture.composer.trigger));
    await updatePrompt(_fixture, `${command} @src`);

    expect(_fixture.composer.trigger?.query).toBe("src");
  });

  it("can reopen after the caret leaves the dismissed word", async () => {
    await using _fixture = _createFixture();

    await using _screen = await renderComposer(_fixture);
    await act(() => _fixture.composer.dismissTrigger(_fixture.composer.trigger));
    await updatePrompt(_fixture, initialPrompt, 0);
    await updatePrompt(_fixture, initialPrompt);

    expect(_fixture.composer.trigger?.query).toBe("openai");
  });

  it("can reopen at the same position after deleting and retyping @", async () => {
    await using _fixture = _createFixture();

    await using _screen = await renderComposer(_fixture);
    await act(() => _fixture.composer.dismissTrigger(_fixture.composer.trigger));
    const prefix = initialPrompt.slice(0, initialPrompt.indexOf("@"));
    await updatePrompt(_fixture, prefix);
    await updatePrompt(_fixture, `${prefix}@`);

    expect(_fixture.composer.trigger?.query).toBe("");
  });

  it("clears dismissal when switching drafts or pending questions", async () => {
    await using _fixture = _createFixture();

    await using _screen = await renderComposer(_fixture);
    await act(() => _fixture.composer.dismissTrigger(_fixture.composer.trigger));
    const candidate = detectComposerTrigger(initialPrompt, initialPrompt.length);
    await act(() => _fixture.composer.resetTrigger(candidate));

    expect(_fixture.composer.trigger).toEqual(candidate);
    expect(_fixture.composer.resolveTrigger(candidate)).toEqual(candidate);
  });

  it.each(["/plan", "$skill", "#123"])("also dismisses %s suggestions", async (text) => {
    await using _fixture = _createFixture();

    await using _screen = await renderComposer(_fixture);
    await updatePrompt(_fixture, text);
    await act(() => _fixture.composer.dismissTrigger(_fixture.composer.trigger));
    await updatePrompt(_fixture, `${text}x`);

    expect(_fixture.composer.trigger).toBeNull();
    await updatePrompt(_fixture, "@src");
    expect(_fixture.composer.trigger?.kind).toBe("path");
  });
});

function _createFixture() {
  let _published_composer = undefined! as ReturnType<typeof useComposerTriggerState>;

  const stack = new AsyncDisposableStack();
  return {
    get composer() {
      return _published_composer;
    },
    publishComposer(next: typeof _published_composer) {
      _published_composer = next;
    },
    stack,
    async [Symbol.asyncDispose]() {
      await stack.disposeAsync();
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
