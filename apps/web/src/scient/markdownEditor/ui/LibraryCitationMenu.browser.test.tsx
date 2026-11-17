import "../../../index.css";
import "../scient-markdown-editor.css";
import { TextSelection } from "prosemirror-state";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../../test/render";
import { ScientMarkdownEditorView } from "../prosemirror/view";
import { ScientMarkdownControls } from "./ScientMarkdownControls";

it("keeps citation choices inside a narrow editor and lets the person choose one", async () => {
  await using resources = new AsyncDisposableStack();
  const host = document.createElement("div");
  host.className = "scient-markdown-rich-pane";
  host.style.width = "180px";
  host.style.flex = "none";
  document.body.append(host);
  resources.defer(() => host.remove());
  const editorHost = document.createElement("div");
  const controlsHost = document.createElement("div");
  host.append(controlsHost, editorHost);
  const controller = new ScientMarkdownEditorView({
    source: "See\n",
    revision: "r0",
    mode: "write",
    ariaLabel: "Document",
  });
  resources.defer(() => controller.destroy());
  const view = controller.mount(editorHost);
  controller.setLibraryCitations([
    {
      sourceId: "ada",
      citationKey: "lovelace1843notes",
      label: "Lovelace 1843",
      title: "Notes on the analytical engine",
    },
  ]);
  const screen = resources.use(
    await render(
      <ScientMarkdownControls
        controller={controller}
        expanded
        onExpandedChange={() => undefined}
      />,
      { container: controlsHost, router: false },
    ),
  );
  await act(() => {
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    view.dispatch(view.state.tr.insertText(" [@"));
  });
  const choices = screen.getByRole("listbox", { name: "Cite from Library" });
  await expect.element(choices).toBeVisible();
  const bounds = choices.element().getBoundingClientRect();
  const available = host.getBoundingClientRect();
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.left).toBeGreaterThanOrEqual(available.left);
  expect(bounds.right).toBeLessThanOrEqual(available.right);
  await userEvent.click(screen.getByRole("option"));
  expect(controller.session.session.draftSource).toContain("[@lovelace1843notes]");
});
