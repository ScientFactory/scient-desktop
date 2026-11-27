import { describe, expect, it } from "vite-plus/test";
import { observeWorkspaceInteraction } from "./workspaceReadiness";

const PROJECT_ID = "project-restored";

function mountWorkspace() {
  const root = document.createElement("div");
  root.innerHTML = `
    <header>
      <button type="button" data-workspace-project-id="${PROJECT_ID}">
        <span>restart-qualification-project</span>
      </button>
    </header>
    <main><div data-testid="composer-editor" contenteditable="true">Ask anything</div></main>`;
  document.body.append(root);
  const control = root.querySelector("button")!;
  const composer = root.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
  return {
    root,
    control,
    composer,
    [Symbol.dispose]() {
      document.body.inert = false;
      root.remove();
    },
  };
}

const observe = (projectId: string | null = PROJECT_ID) =>
  observeWorkspaceInteraction(document, projectId);

describe("observeWorkspaceInteraction", () => {
  it("finds the restored project's control and the composer in an unlocked window", () => {
    using _workspace = mountWorkspace();
    expect(observe()).toEqual({
      projectControlsVisible: true,
      composerUsable: true,
      windowUnlocked: true,
    });
  });

  it("reports a window still locked for the restart as unusable", () => {
    using _workspace = mountWorkspace();
    document.body.inert = true;
    expect(observe()).toEqual({
      projectControlsVisible: false,
      composerUsable: false,
      windowUnlocked: false,
    });
  });

  it("needs the restored project's own control, not its title text or another project's", () => {
    using workspace = mountWorkspace();
    expect(observe("another-project").projectControlsVisible).toBe(false);
    expect(observe(null).projectControlsVisible).toBe(false);
    workspace.control.removeAttribute("data-workspace-project-id");
    // The project's name is still on screen in a plain button.
    expect(observe().projectControlsVisible).toBe(false);
  });

  it("needs the chat composer itself, editable, not any other editor", () => {
    using workspace = mountWorkspace();
    const other = document.createElement("div");
    other.contentEditable = "true";
    workspace.root.append(other);
    workspace.composer.removeAttribute("data-testid");
    expect(observe().composerUsable).toBe(false);
    workspace.composer.dataset.testid = "composer-editor";
    workspace.composer.contentEditable = "false";
    expect(observe().composerUsable).toBe(false);
    workspace.composer.contentEditable = "true";
    workspace.composer.setAttribute("aria-readonly", "true");
    expect(observe().composerUsable).toBe(false);
  });

  it("does not count controls that are inert, hidden, disabled or covered", () => {
    using workspace = mountWorkspace();
    workspace.root.querySelector("header")!.style.visibility = "hidden";
    workspace.root.querySelector("main")!.inert = true;
    expect(observe()).toEqual({
      projectControlsVisible: false,
      composerUsable: false,
      windowUnlocked: true,
    });
    workspace.root.querySelector("header")!.style.visibility = "";
    workspace.root.querySelector("main")!.inert = false;
    workspace.control.disabled = true;
    expect(observe().projectControlsVisible).toBe(false);
    workspace.control.disabled = false;
    workspace.control.setAttribute("aria-disabled", "true");
    expect(observe().projectControlsVisible).toBe(false);
    workspace.control.removeAttribute("aria-disabled");

    // A modal backdrop over the whole window takes every click.
    const overlay = document.createElement("div");
    overlay.style.cssText = "position: fixed; inset: 0; z-index: 10;";
    workspace.root.append(overlay);
    expect(observe()).toEqual({
      projectControlsVisible: false,
      composerUsable: false,
      windowUnlocked: true,
    });
    // One that lets clicks through does not.
    overlay.style.pointerEvents = "none";
    expect(observe()).toEqual({
      projectControlsVisible: true,
      composerUsable: true,
      windowUnlocked: true,
    });
  });
});
