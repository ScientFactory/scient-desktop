import { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ScientQuickChatMoveMenu } from "./ScientQuickChatMoveMenu";

describe("ScientQuickChatMoveMenu", () => {
  it("renders one accessible relocation control", () => {
    const markup = renderToStaticMarkup(
      <ScientQuickChatMoveMenu
        environmentId={EnvironmentId.make("local")}
        targets={[]}
        isMoving={false}
        disabledReason={null}
        onMove={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Move chat to project"');
    expect(markup).not.toContain('title="Move chat to project"');
    expect(markup).toContain("lucide-folder-input");
    expect(markup).not.toContain("lucide-loader-circle");
  });

  it("disables the control and communicates an unavailable target", () => {
    const markup = renderToStaticMarkup(
      <ScientQuickChatMoveMenu
        environmentId={EnvironmentId.make("local")}
        targets={[]}
        isMoving={false}
        disabledReason="Add a project before moving this chat"
        onMove={() => {}}
      />,
    );

    expect(markup).toContain("disabled");
    expect(markup).toContain("Add a project before moving this chat");
  });
});
