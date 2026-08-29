// @vitest-environment happy-dom

import type { EditorView as CodeMirrorEditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ScientCm6EditorView } from "./view";

const controllers: ScientCm6EditorView[] = [];

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.destroy());
  document.body.replaceChildren();
});

function mountController(
  source: string,
  resolveImageSource?: (authoredSource: string) => Promise<string | null>,
  onOpenLink?: (target: string) => void,
): ScientCm6EditorView {
  const controller = new ScientCm6EditorView({
    source,
    revision: "sha256:test",
    placeholder: "Start writing…",
    onUserSourceChange: vi.fn(),
    ...(resolveImageSource ? { resolveImageSource } : {}),
    ...(onOpenLink ? { onOpenLink } : {}),
  });
  const host = document.createElement("div");
  document.body.append(host);
  controllers.push(controller);
  controller.mount(host);
  return controller;
}

describe("ScientCm6EditorView resources", () => {
  it("refreshes an image widget when its document-scoped URL resolves", async () => {
    let resolve!: (value: string | null) => void;
    const pending = new Promise<string | null>((resolvePromise) => {
      resolve = resolvePromise;
    });
    const source = "![Chart](images/chart.png)\n\nAfter\n";
    const controller = mountController(source, () => pending);
    controller.view?.dispatch({ selection: { anchor: source.length } });

    expect(document.body.querySelector(".cm-md-image-pending")?.textContent).toBe(
      "images/chart.png",
    );
    resolve("scient-asset://chart");
    await vi.waitFor(() => {
      expect(document.body.querySelector<HTMLImageElement>(".cm-md-image img")?.src).toBe(
        "scient-asset://chart",
      );
    });
    expect(controller.view?.state.doc.toString()).toBe(source);
  });

  it("renders an image whose alternative text is intentionally empty", async () => {
    const source = "![](images/chart.png)\n\nAfter\n";
    const controller = mountController(source, async () => "scient-asset://chart");
    controller.view?.dispatch({ selection: { anchor: source.length } });

    await vi.waitFor(() => {
      expect(document.body.querySelector<HTMLImageElement>(".cm-md-image img")?.src).toBe(
        "scient-asset://chart",
      );
    });
    expect(document.body.querySelector<HTMLImageElement>(".cm-md-image img")?.alt).toBe("");
  });

  it("gives a task checkbox an action and the task text as its accessible name", () => {
    const source = "- [ ] Ship the release\n\nAfter\n";
    const controller = mountController(source);
    controller.view?.dispatch({ selection: { anchor: source.length } });

    expect(
      document.body
        .querySelector<HTMLInputElement>(".cm-md-task input")
        ?.getAttribute("aria-label"),
    ).toBe("Mark task complete: Ship the release");
  });

  it("opens a link through the controller callback", () => {
    const onOpenLink = vi.fn();
    const source = "[Docs](guide.md)\n\nAfter\n";
    const controller = mountController(source, undefined, onOpenLink);
    const view = controller.view!;
    vi.spyOn(view, "posAtCoords").mockReturnValue(2);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    const handled = (
      controller as unknown as {
        handleLinkClick: (event: MouseEvent, view: CodeMirrorEditorView) => boolean;
      }
    ).handleLinkClick(event, view);

    expect(handled).toBe(true);
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("guide.md");
  });

  it("releases every editor across repeated document replacements", () => {
    for (let index = 0; index < 20; index += 1) {
      const controller = mountController(`# Document ${index}\n`);
      expect(document.body.querySelectorAll(".cm-editor")).toHaveLength(1);
      controller.destroy();
      expect(document.body.querySelector(".cm-editor")).toBeNull();
      document.body.replaceChildren();
    }
  });

  it("destroys the mounted view idempotently", () => {
    const controller = mountController("# Title\n");
    expect(document.body.querySelector(".cm-editor")).not.toBeNull();

    controller.destroy();
    controller.destroy();

    expect(controller.view).toBeNull();
    expect(document.body.querySelector(".cm-editor")).toBeNull();
  });
});
