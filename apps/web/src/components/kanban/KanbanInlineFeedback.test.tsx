import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { KanbanInlineFeedback } from "./KanbanInlineFeedback";

describe("KanbanInlineFeedback", () => {
  it("announces actionable errors assertively next to the kanban surface", () => {
    const markup = renderToStaticMarkup(
      <KanbanInlineFeedback
        feedback={{
          tone: "error",
          title: "Could not send draft",
          description: "Reconnect and try again.",
        }}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain("Could not send draft");
    expect(markup).toContain("Reconnect and try again.");
  });

  it("announces routine local confirmation politely", () => {
    const markup = renderToStaticMarkup(
      <KanbanInlineFeedback feedback={{ tone: "success", title: "Path copied" }} />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Path copied");
  });

  it("resets route-scoped feedback when the selected project changes", () => {
    const routeSource = readFileSync(new URL("./KanbanView.tsx", import.meta.url), "utf8");
    const boardSource = readFileSync(
      new URL("./KanbanProjectBoardView.tsx", import.meta.url),
      "utf8",
    );

    expect(routeSource).toMatch(
      /useEffect\(\(\) => \{\s*clearCardActionFeedback\(\);\s*\}, \[clearCardActionFeedback, projectId\]\);/,
    );
    expect(boardSource).toMatch(
      /useEffect\(\(\) => \{\s*setActiveCard\(null\);\s*setFeedback\(null\);\s*\}, \[board\.projectId\]\);/,
    );
  });
});
