import { describe, expect, it } from "vite-plus/test";
import { observeWorkspaceInteraction } from "./workspaceReadiness";

function mountWorkspace() {
  const root = document.createElement("div");
  root.innerHTML = `
    <nav><button type="button"><span>restart-qualification-project</span></button></nav>
    <main><div contenteditable="true">Ask anything</div></main>`;
  document.body.append(root);
  return {
    root,
    [Symbol.dispose]() {
      document.body.inert = false;
      root.remove();
    },
  };
}

describe("observeWorkspaceInteraction", () => {
  it("finds the restored project's control and a usable composer in an unlocked window", () => {
    using _workspace = mountWorkspace();
    expect(observeWorkspaceInteraction(document, "restart-qualification-project")).toEqual({
      projectControlsVisible: true,
      composerUsable: true,
      windowUnlocked: true,
    });
  });

  it("reports a window still locked for the restart as unusable", () => {
    using _workspace = mountWorkspace();
    document.body.inert = true;
    expect(observeWorkspaceInteraction(document, "restart-qualification-project")).toEqual({
      projectControlsVisible: false,
      composerUsable: false,
      windowUnlocked: false,
    });
  });

  it("does not count hidden or inert controls, or another project's", () => {
    using workspace = mountWorkspace();
    workspace.root.querySelector("nav")!.style.visibility = "hidden";
    workspace.root.querySelector("main")!.inert = true;
    expect(observeWorkspaceInteraction(document, "restart-qualification-project")).toEqual({
      projectControlsVisible: false,
      composerUsable: false,
      windowUnlocked: true,
    });
    workspace.root.querySelector("nav")!.style.visibility = "";
    expect(observeWorkspaceInteraction(document, "another-project").projectControlsVisible).toBe(
      false,
    );
    expect(observeWorkspaceInteraction(document, null).projectControlsVisible).toBe(false);
  });
});
