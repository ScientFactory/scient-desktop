// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vite-plus/test";

import { scientCm6FindState } from "./find";
import { ScientCm6EditorView } from "./view";

describe("ScientCm6EditorView find", () => {
  const mounted: ScientCm6EditorView[] = [];

  afterEach(() => {
    mounted.splice(0).forEach((controller) => controller.view?.destroy());
    document.body.replaceChildren();
  });

  function mountEditor(source: string): ScientCm6EditorView {
    const controller = new ScientCm6EditorView({
      source,
      revision: "sha256:test",
      placeholder: "Start writing…",
      onUserSourceChange: () => undefined,
    });
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(controller);
    controller.mount(host);
    return controller;
  }

  it("counts matches and navigates with wrap-around", () => {
    const controller = mountEditor("alpha beta alpha\n\nalpha again\n");
    controller.requestFind();
    controller.configureFind({ query: "alpha", caseSensitive: false, wholeWord: false });

    expect(controller.getFindSnapshot().findMatchCount).toBe(3);
    expect(controller.getFindSnapshot().findOpen).toBe(true);

    const view = controller.view;
    expect(view).not.toBeNull();
    if (!view) return;
    expect(scientCm6FindState(view.state).decorations.size).toBe(3);

    controller.navigateFind(1);
    expect(controller.getFindSnapshot().findActiveIndex).toBe(1);
    const selection = view.state.selection.main;
    expect(view.state.sliceDoc(selection.from, selection.to)).toBe("alpha");

    controller.navigateFind(1);
    controller.navigateFind(1);
    expect(controller.getFindSnapshot().findActiveIndex).toBe(0);
  });

  it("honors case sensitivity and whole word", () => {
    const controller = mountEditor("Alpha alpha alphabet\n");
    controller.configureFind({ query: "alpha", caseSensitive: true, wholeWord: false });
    expect(controller.getFindSnapshot().findMatchCount).toBe(2);

    controller.configureFind({ query: "alpha", caseSensitive: true, wholeWord: true });
    expect(controller.getFindSnapshot().findMatchCount).toBe(1);

    controller.configureFind({ query: "Alpha", caseSensitive: false, wholeWord: false });
    expect(controller.getFindSnapshot().findMatchCount).toBe(3);
  });

  it("replaces the active match and then all matches", () => {
    const controller = mountEditor("alpha beta alpha\n");
    controller.configureFind({ query: "alpha", caseSensitive: false, wholeWord: false });

    expect(controller.replaceFind("omega", false)).toBe(true);
    expect(controller.view?.state.doc.toString()).toBe("omega beta alpha\n");

    expect(controller.replaceFind("omega", true)).toBe(true);
    expect(controller.view?.state.doc.toString()).toBe("omega beta omega\n");
  });

  it("closing find clears the query and decorations", () => {
    const controller = mountEditor("alpha alpha\n");
    controller.requestFind();
    controller.configureFind({ query: "alpha", caseSensitive: false, wholeWord: false });
    expect(controller.getFindSnapshot().findMatchCount).toBe(2);

    controller.setFindOpen(false);
    const snapshot = controller.getFindSnapshot();
    expect(snapshot.findOpen).toBe(false);
    expect(snapshot.findQuery).toBe("");
    expect(snapshot.findMatchCount).toBe(0);
    const view = controller.view;
    expect(view).not.toBeNull();
    if (!view) return;
    expect(scientCm6FindState(view.state).decorations.size).toBe(0);
  });

  it("returns a stable snapshot object until find state changes", () => {
    const controller = mountEditor("alpha\n");
    const first = controller.getFindSnapshot();
    expect(controller.getFindSnapshot()).toBe(first);

    controller.configureFind({ query: "alpha", caseSensitive: false, wholeWord: false });
    expect(controller.getFindSnapshot()).not.toBe(first);
    expect(controller.getFindSnapshot().findMatchCount).toBe(1);
  });
});
