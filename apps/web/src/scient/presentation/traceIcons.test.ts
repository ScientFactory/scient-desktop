import { describe, expect, it } from "vite-plus/test";

import {
  groupTraceIconOverride,
  isScientSkillTool,
  traceCommandKind,
  traceIconOverride,
} from "./traceIcons";

const tool = (fields: Partial<Parameters<typeof traceIconOverride>[0]>) => ({
  label: "Tool call",
  tone: "tool" as const,
  ...fields,
});

describe("trace icons", () => {
  it("reads a command's program", () => {
    expect(traceCommandKind("ls -la src")).toBe("list");
    expect(traceCommandKind("cd app && tree -L 2")).toBe("list");
    expect(traceCommandKind("curl -s https://example.com")).toBe("fetch");
    expect(traceCommandKind("pnpm test")).toBeNull();
    expect(traceCommandKind(undefined)).toBeNull();
  });

  it("recognizes Scient's skill tools in every provider's spelling", () => {
    for (const name of [
      "scient_skills_list",
      "scient_skill_load",
      "mcp__t3-code__scient_skill_read_resource",
      "t3-code · scient_skills_list",
    ]) {
      expect(isScientSkillTool([name])).toBe(true);
    }
    expect(isScientSkillTool(["scient_sources_list", "skill", undefined])).toBe(false);
  });

  it("picks an icon from what an action did", () => {
    expect(
      traceIconOverride(tool({ sourceActivityKind: "approval.requested", tone: "info" })),
    ).toBe("shield");
    expect(traceIconOverride(tool({ toolData: { toolName: "scient_skill_load" } }))).toBe("skill");
    expect(traceIconOverride(tool({ itemType: "image_view" }))).toBe("image");
    expect(traceIconOverride(tool({ toolTitle: "glob" }))).toBe("folder");
    expect(traceIconOverride(tool({ itemType: "command_execution", command: "ls" }))).toBe(
      "folder",
    );
    expect(traceIconOverride(tool({ itemType: "command_execution", command: "wget x" }))).toBe(
      "globe",
    );
    expect(
      traceIconOverride(tool({ itemType: "command_execution", command: "make" })),
    ).toBeUndefined();
  });

  it("gives a group the icon all of its actions share", () => {
    const approval = tool({ sourceActivityKind: "approval.resolved", tone: "info" });
    expect(groupTraceIconOverride([approval, approval])).toBe("shield");
    expect(groupTraceIconOverride([approval, tool({ itemType: "image_view" })])).toBeUndefined();
    expect(groupTraceIconOverride([])).toBeUndefined();
  });
});
