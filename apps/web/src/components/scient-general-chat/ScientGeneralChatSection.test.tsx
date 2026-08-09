import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  SCIENT_GENERAL_CHAT_DEFAULT_EXPANDED,
  ScientGeneralChatSection,
} from "./ScientGeneralChatSection";

describe("ScientGeneralChatSection", () => {
  it("starts collapsed until the user opens it", () => {
    expect(SCIENT_GENERAL_CHAT_DEFAULT_EXPANDED).toBe(false);
  });

  it("renders a compact, labelled list when expanded", () => {
    const markup = renderToStaticMarkup(
      <ScientGeneralChatSection expanded itemCount={2} onToggle={() => {}}>
        <li>First chat</li>
        <li>Second chat</li>
      </ScientGeneralChatSection>,
    );

    expect(markup).toContain('aria-label="General chat"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-label="General chats"');
    expect(markup).toContain("lucide-message-circle");
    expect(markup).toContain("--scient-burgundy");
    expect(markup).toContain('data-testid="scient-general-chat-divider"');
    expect(markup).toContain("First chat");
    expect(markup).toContain("Second chat");
  });

  it("does not mount chat rows while collapsed", () => {
    const markup = renderToStaticMarkup(
      <ScientGeneralChatSection expanded={false} itemCount={1} onToggle={() => {}}>
        <li>Hidden chat</li>
      </ScientGeneralChatSection>,
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Hidden chat");
  });
});
