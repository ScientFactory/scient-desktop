import "../../index.css";

import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { SelectionCitationToolbar } from "./AssistantSelectionToolbar";

it("leaves Tab to a code editor, which indents the selection with it", async () => {
  const viewport = document.createElement("div");
  viewport.innerHTML = '<div class="cm-editor"><div contenteditable="true">code</div></div>';
  document.body.append(viewport);
  const sourceAnchor = {
    source: viewport,
    viewport,
    range: document.createRange(),
    resolveRects: () => [new DOMRect(10, 10, 40, 20)],
  };
  await using _screen = await render(
    <SelectionCitationToolbar
      viewport={viewport}
      capture={() => ({ citation: { text: "code" }, sourceAnchor })}
      onCite={() => true}
    />,
    { router: false },
  );
  const action = () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Ask in chat"]');
  viewport.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true }),
  );
  viewport.dispatchEvent(
    new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 20, clientY: 20 }),
  );
  await expect.poll(action).not.toBeNull();
  const press = (target: Element) => {
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(press(viewport.querySelector("[contenteditable]")!)).toBe(false);
  expect(document.activeElement).not.toBe(action());
  expect(press(viewport)).toBe(true);
  expect(document.activeElement).toBe(action());
  viewport.remove();
});
