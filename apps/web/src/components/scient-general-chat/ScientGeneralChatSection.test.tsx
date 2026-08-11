import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ScientGeneralChatSection } from "./ScientGeneralChatSection";

describe("ScientGeneralChatSection", () => {
  it("renders a compact, labelled list when expanded", () => {
    const markup = renderToStaticMarkup(
      <ScientGeneralChatSection expanded itemCount={2} onToggle={() => {}} onCreate={() => {}}>
        <li>First chat</li>
        <li>Second chat</li>
      </ScientGeneralChatSection>,
    );

    expect(markup).toContain('aria-label="General chat"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-label="General chats"');
    expect(markup).toContain('aria-label="New chat without a project"');
    expect(markup).toContain("lucide-plus");
    expect(markup).toContain("lucide-message-circle");
    expect(markup).toContain("text-sidebar-muted-foreground/80");
    expect(markup).not.toContain("--scient-burgundy");
    expect(markup).not.toContain("--scient-warm-white");
    expect(markup).toContain("--sidebar-control-gap");
    expect(markup).toContain("--sidebar-row-content-inset");
    expect(markup.match(/--sidebar-icon-color/g)).toHaveLength(3);
    expect(markup).toContain("hover:text-sidebar-foreground");
    expect(markup).toContain("items-center gap-1");
    expect(markup).toContain('data-testid="scient-general-chat-divider"');
    expect(markup).toContain("First chat");
    expect(markup).toContain("Second chat");
  });

  it("does not mount chat rows while collapsed", () => {
    const markup = renderToStaticMarkup(
      <ScientGeneralChatSection
        expanded={false}
        itemCount={1}
        onToggle={() => {}}
        onCreate={() => {}}
      >
        <li>Hidden chat</li>
      </ScientGeneralChatSection>,
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Hidden chat");
  });
});
