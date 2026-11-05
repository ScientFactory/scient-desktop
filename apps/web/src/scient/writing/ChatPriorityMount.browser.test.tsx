import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { expect, it } from "vite-plus/test";
import { fakeTimers, render } from "../../../test/render";
import { advanceTestClock } from "../../../test/testClock";
import { ChatPriorityMount } from "./ChatPriorityMount";
import { InputPriority } from "./inputPriority";
import { useChatPriorityPanelOpen } from "./useChatPriorityPanelOpen";

function Panel({
  requested,
  scope = "thread",
  defer = true,
}: {
  requested: boolean;
  scope?: string;
  defer?: boolean;
}) {
  const open = useChatPriorityPanelOpen(requested, scope, defer);
  return open ? <div data-testid="panel">{scope}</div> : null;
}

async function fixture() {
  const cleanup = new AsyncDisposableStack();
  try {
    const screen = await render(null, { router: false });
    cleanup.use(fakeTimers());
    cleanup.use(screen);
    const host = document.createElement("div");
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, InputPriority.configure({ chat: true })],
      content: "<p>Chat</p>",
    });
    cleanup.defer(() => {
      editor.destroy();
      host.remove();
    });
    editor.view.dom.focus();
    const input = () => editor.view.dom.dispatchEvent(new Event("beforeinput", { bubbles: true }));
    return { screen, editor, input, [Symbol.asyncDispose]: () => cleanup.disposeAsync() };
  } catch (error) {
    await cleanup.disposeAsync();
    throw error;
  }
}

it("holds new preview mounts during typing and opens the latest content after blur", async ({
  signal,
}) => {
  await using current = await fixture();
  const { screen, editor, input } = current;
  input();
  await screen.rerender(
    <ChatPriorityMount fallback={<span>Waiting</span>}>
      <div data-testid="preview">First request</div>
    </ChatPriorityMount>,
  );
  expect(screen.container.querySelector('[data-testid="preview"]')).toBeNull();
  await advanceTestClock(signal, 400);
  input();
  await screen.rerender(
    <ChatPriorityMount fallback={<span>Waiting</span>}>
      <div data-testid="preview">Latest request</div>
    </ChatPriorityMount>,
  );
  await advanceTestClock(signal, 400);
  expect(screen.container.querySelector('[data-testid="preview"]')).toBeNull();
  editor.view.dom.blur();
  await advanceTestClock(signal, 0);
  expect(screen.container.querySelector('[data-testid="preview"]')?.textContent).toBe(
    "Latest request",
  );
});

it("opens idle previews promptly and never opens a pending preview after it closes", async ({
  signal,
}) => {
  await using current = await fixture();
  const { screen, input } = current;
  const preview = (key: string) => (
    <ChatPriorityMount key={key} fallback={<span>Waiting</span>}>
      <div data-testid="preview">{key}</div>
    </ChatPriorityMount>
  );
  await screen.rerender(preview("Idle"));
  await advanceTestClock(signal, 1);
  expect(screen.container.querySelector('[data-testid="preview"]')?.textContent).toBe("Idle");
  input();
  await screen.rerender(preview("Pending"));
  expect(screen.container.querySelector('[data-testid="preview"]')).toBeNull();
  await screen.rerender(null);
  await advanceTestClock(signal, 1000);
  expect(screen.container.querySelector('[data-testid="preview"]')).toBeNull();
});

it("holds document-pane layout during typing, then keeps an opened pane stable", async ({
  signal,
}) => {
  await using current = await fixture();
  const { screen, input } = current;
  input();
  await screen.rerender(<Panel requested />);
  expect(screen.container.querySelector('[data-testid="panel"]')).toBeNull();
  await advanceTestClock(signal, 400);
  input();
  await advanceTestClock(signal, 400);
  expect(screen.container.querySelector('[data-testid="panel"]')).toBeNull();
  await advanceTestClock(signal, 100);
  expect(screen.container.querySelector('[data-testid="panel"]')?.textContent).toBe("thread");
  input();
  await screen.rerender(<Panel requested />);
  expect(screen.container.querySelector('[data-testid="panel"]')).not.toBeNull();
  await screen.rerender(<Panel requested={false} />);
  expect(screen.container.querySelector('[data-testid="panel"]')).toBeNull();
});

it("cancels deferred opens on close or thread change and leaves other panel types immediate", async ({
  signal,
}) => {
  await using current = await fixture();
  const { screen, input } = current;
  input();
  await screen.rerender(<Panel requested scope="old" />);
  await screen.rerender(<Panel requested={false} scope="old" />);
  await advanceTestClock(signal, 600);
  expect(screen.container.querySelector('[data-testid="panel"]')).toBeNull();
  input();
  await screen.rerender(<Panel requested scope="new" />);
  expect(screen.container.querySelector('[data-testid="panel"]')).toBeNull();
  await advanceTestClock(signal, 500);
  expect(screen.container.querySelector('[data-testid="panel"]')?.textContent).toBe("new");
  input();
  await screen.rerender(<Panel requested scope="terminal" defer={false} />);
  expect(screen.container.querySelector('[data-testid="panel"]')?.textContent).toBe("terminal");
});
