import { MessageId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useChatContentDirection } from "./useChatContentDirection";

type Props = Parameters<typeof useChatContentDirection>[0];
let props: Props;
let resolved: string | null;
let renderer: Root;
let container: HTMLDivElement;

function Probe(input: Props) {
  const value = useChatContentDirection(input).resolvedContentDirection;
  useLayoutEffect(() => {
    resolved = value;
  });
  return null;
}

async function update(patch: Partial<Props>) {
  props = { ...props, ...patch };
  await act(() => renderer.render(<Probe {...props} />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resolved = null;
  props = {
    text: "",
    contentDirection: undefined,
    messageId: MessageId.make("message-1"),
    directionHint: undefined,
    isStreaming: true,
  };
  container = document.createElement("div");
  document.body.append(container);
  renderer = createRoot(container);
});

afterEach(async () => {
  await act(() => renderer.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("holds a streaming message's first direction as tokens arrive", async () => {
  await update({ text: "שלום" });
  expect(resolved).toBe("rtl");
  await update({ text: "שלום and then a long English sentence that would read as ltr" });
  expect(resolved).toBe("rtl");
});

it("keeps the held direction as the fallback after completion, on every render", async () => {
  await update({ text: "שלום" });
  await update({ text: "123", isStreaming: false });
  expect(resolved).toBe("rtl");
  await update({});
  expect(resolved).toBe("rtl");
});

it("lets completed text with a strong script decide, and re-holds for the next stream", async () => {
  await update({ text: "שלום" });
  await update({ text: "A finished English answer", isStreaming: false });
  expect(resolved).toBe("ltr");
  await update({ messageId: MessageId.make("message-2"), text: "Hello", isStreaming: true });
  expect(resolved).toBe("ltr");
  await update({ text: "Hello שלום עולם", isStreaming: true });
  expect(resolved).toBe("ltr");
});
