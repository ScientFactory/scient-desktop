import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { MessageId } from "@t3tools/contracts";
import { useLayoutEffect } from "react";

import { expect, it, vi } from "vite-plus/test";

import { useChatContentDirection } from "./useChatContentDirection";

type Props = Parameters<typeof useChatContentDirection>[0];

function Probe({ _fixture, ...input }: Props & { _fixture: _Fixture }) {
  const value = useChatContentDirection(input).resolvedContentDirection;
  useLayoutEffect(() => {
    _fixture.publishResolved(value);
  });
  return null;
}

async function update(_fixture: _Fixture, patch: Partial<Props>) {
  _fixture.props = { ..._fixture.props, ...patch };
  await act(
    async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} {..._fixture.props} />),
  );
}

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.publishResolved(null);
  _fixture.props = {
    text: "",
    contentDirection: undefined,
    messageId: MessageId.make("message-1"),
    directionHint: undefined,
    isStreaming: true,
  };
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

it("holds a streaming message's first direction as tokens arrive", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await update(_fixture, { text: "שלום" });
  expect(_fixture.resolved).toBe("rtl");
  await update(_fixture, { text: "שלום and then a long English sentence that would read as ltr" });
  expect(_fixture.resolved).toBe("rtl");
});

it("keeps the held direction as the fallback after completion, on every render", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await update(_fixture, { text: "שלום" });
  await update(_fixture, { text: "123", isStreaming: false });
  expect(_fixture.resolved).toBe("rtl");
  await update(_fixture, {});
  expect(_fixture.resolved).toBe("rtl");
});

it("lets completed text with a strong script decide, and re-holds for the next stream", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await update(_fixture, { text: "שלום" });
  await update(_fixture, { text: "A finished English answer", isStreaming: false });
  expect(_fixture.resolved).toBe("ltr");
  await update(_fixture, {
    messageId: MessageId.make("message-2"),
    text: "Hello",
    isStreaming: true,
  });
  expect(_fixture.resolved).toBe("ltr");
  await update(_fixture, { text: "Hello שלום עולם", isStreaming: true });
  expect(_fixture.resolved).toBe("ltr");
});

function _createFixture() {
  let _published_resolved = undefined! as string | null;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    props: undefined! as Props,
    get resolved() {
      return _published_resolved;
    },
    publishResolved(next: typeof _published_resolved) {
      _published_resolved = next;
      return next;
    },

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
