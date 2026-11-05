import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it, vi } from "vite-plus/test";
import { fakeTimers } from "../../../test/render";
import { advanceTestClock } from "../../../test/testClock";
import {
  InputPriority,
  afterChatInputQuiet,
  chatInputQuietDelay,
  waitForChatInputQuiet,
} from "./inputPriority";
import { prioritizeChatOverScroll } from "./chatPriorityScroll";
import { prioritizePdfWork } from "../pdf/pdfChatPriority";
import { scheduleMathFieldMount } from "../latex/mathFieldMountQueue";

function composer() {
  const cleanup = new DisposableStack();
  cleanup.use(fakeTimers());
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit, InputPriority.configure({ chat: true })],
    content: "<p>Chat</p>",
  });
  editor.view.dom.focus();
  cleanup.defer(() => {
    editor.destroy();
    element.remove();
  });
  const input = () => editor.view.dom.dispatchEvent(new Event("beforeinput", { bubbles: true }));
  input();
  return { editor, input, cleanup, [Symbol.dispose]: () => cleanup.dispose() };
}

describe("chat has priority over document work", () => {
  it("holds visible document formula warming while chat is being edited", async ({ signal }) => {
    using fixture = composer();
    const { input } = fixture;
    const work = vi.fn();
    const job = scheduleMathFieldMount(work, () => 2);
    fixture.cleanup.defer(job.cancel);
    await advanceTestClock(signal, 400);
    input();
    await advanceTestClock(signal, 400);
    expect(work).not.toHaveBeenCalled();
    await advanceTestClock(signal, 101);
    expect(work).toHaveBeenCalledOnce();
  });

  it("extends the quiet window during typing, composition and releases it on blur", async ({
    signal,
  }) => {
    using fixture = composer();
    const { editor, input } = fixture;
    const work = vi.fn();
    fixture.cleanup.defer(afterChatInputQuiet(work));
    await advanceTestClock(signal, 400);
    input();
    await advanceTestClock(signal, 400);
    expect(work).not.toHaveBeenCalled();
    editor.view.dom.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    await advanceTestClock(signal, 1000);
    expect(work).not.toHaveBeenCalled();
    editor.view.dom.blur();
    await advanceTestClock(signal, 0);
    expect(work).toHaveBeenCalledOnce();
    expect(chatInputQuietDelay()).toBe(0);
  });

  it("coalesces document scrolling and resumes at the latest native position", async ({
    signal,
  }) => {
    using fixture = composer();
    const { input } = fixture;
    const container = document.createElement("div");
    const viewport = document.createElement("div");
    // Control positions without native scroll events racing the fake scheduling clock.
    Object.defineProperty(viewport, "scrollTop", { value: 0, writable: true });
    container.append(viewport);
    document.body.append(container);
    const stop = prioritizeChatOverScroll(container);
    fixture.cleanup.defer(() => {
      stop();
      container.remove();
    });
    const positions: number[] = [];
    viewport.addEventListener("scroll", () => positions.push(viewport.scrollTop));
    for (let i = 0; i < 5; i++) {
      viewport.scrollTop = i * 100;
      viewport.dispatchEvent(new Event("scroll"));
      input();
    }
    expect(positions).toEqual([]);
    await advanceTestClock(signal, 500);
    expect(positions).toEqual([400]);
    viewport.scrollTop = 800;
    viewport.dispatchEvent(new Event("scroll"));
    expect(positions).toEqual([400, 800]);
    input();
    viewport.dispatchEvent(new Event("scroll"));
    stop();
    await advanceTestClock(signal, 600);
    expect(positions).toEqual([400, 800]);
  });

  it("cancels deferred PDF setup when its source is closed", async ({ signal }) => {
    using _fixture = composer();
    const controller = new AbortController();
    const pending = waitForChatInputQuiet(controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    controller.abort();
    await rejected;
    await advanceTestClock(signal, 1000);
  });

  it("pauses PDF work, resumes once, and cancels pending work on destruction", async ({
    signal,
  }) => {
    using fixture = composer();
    const { input } = fixture;
    const update = vi.fn();
    const render = vi.fn();
    const highest = vi.fn(() => true);
    const queue = { renderHighestPriority: render, isHighestPriority: highest };
    const viewer = { update, renderingQueue: queue };
    const controller = new AbortController();
    prioritizePdfWork(viewer, controller.signal);
    fixture.cleanup.defer(() => controller.abort());
    viewer.update();
    viewer.update();
    queue.renderHighestPriority();
    expect(queue.isHighestPriority()).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    await advanceTestClock(signal, 500);
    expect(update).toHaveBeenCalledOnce();
    expect(queue.isHighestPriority()).toBe(true);
    input();
    viewer.update();
    controller.abort();
    await advanceTestClock(signal, 600);
    expect(update).toHaveBeenCalledOnce();
    expect(viewer.update).toBe(update);
    expect(queue.renderHighestPriority).toBe(render);
  });
});
