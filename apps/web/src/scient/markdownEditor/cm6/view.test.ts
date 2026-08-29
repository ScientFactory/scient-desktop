// @vitest-environment happy-dom

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
): ScientCm6EditorView {
  const controller = new ScientCm6EditorView({
    source,
    revision: "sha256:test",
    placeholder: "Start writing…",
    onUserSourceChange: vi.fn(),
    ...(resolveImageSource ? { resolveImageSource } : {}),
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

  it("destroys the mounted view idempotently", () => {
    const controller = mountController("# Title\n");
    expect(document.body.querySelector(".cm-editor")).not.toBeNull();

    controller.destroy();
    controller.destroy();

    expect(controller.view).toBeNull();
    expect(document.body.querySelector(".cm-editor")).toBeNull();
  });
});
