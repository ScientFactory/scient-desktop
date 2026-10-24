// @effect-diagnostics nodeBuiltinImport:off -- architectural seam reads source text.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const panelSource = NodeFS.readFileSync(NodePath.join(here, "ComputePanel.tsx"), "utf8");
const rightPanelTabsSource = NodeFS.readFileSync(
  NodePath.join(here, "../../components/RightPanelTabs.tsx"),
  "utf8",
);

describe("compute result surface seam", () => {
  // regression: e28be01e7d fix(compute): tighten runtime truth and authority
  it("keeps one secondary Compute-session command in the add-surface menu", () => {
    const primaryActions = rightPanelTabsSource.slice(
      rightPanelTabsSource.indexOf("const addSurfaceActions"),
      rightPanelTabsSource.indexOf("const extraSessionAction"),
    );
    expect(primaryActions).not.toContain('label: "Compute"');
    expect(primaryActions).not.toContain('label: "Scientific computing"');
    expect(rightPanelTabsSource).toContain('label: "Scientific computing"');
  });

  // regression: 43ee632b0c fix(compute): refresh generated files and tighten narrow layouts
  it("refreshes the current workspace tree after successful or failed executions", () => {
    expect(panelSource).toContain(
      "TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status)",
    );
    expect(panelSource).toContain("refreshProjectFiles(props.environmentId, props.cwd)");
    expect(panelSource).not.toContain("getProjectEntriesQueryAtom");
  });
});
