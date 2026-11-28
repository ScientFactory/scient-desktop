import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/ai";

import * as McpHttpServer from "../../McpHttpServer.ts";
import { hostToolVisibility } from "../../ScientMcpProtocol.ts";
import { WhatsAppToolkit } from "./tools.ts";

const hints = (tool: Tool.Any) => ({
  readonly: Context.getOrUndefined(tool.annotations, Tool.Readonly),
  destructive: Context.getOrUndefined(tool.annotations, Tool.Destructive),
  openWorld: Context.getOrUndefined(tool.annotations, Tool.OpenWorld),
});

it("declares the WhatsApp tools with send as the only writing tool", () => {
  const tools = Object.values(WhatsAppToolkit.tools);
  expect(tools.map((tool) => tool.name).toSorted()).toEqual([
    "whatsapp_chats",
    "whatsapp_contacts",
    "whatsapp_messages",
    "whatsapp_search",
    "whatsapp_send",
    "whatsapp_status",
  ]);
  for (const tool of tools) {
    expect(hints(tool), tool.name).toEqual(
      tool.name === "whatsapp_send"
        ? { readonly: false, destructive: false, openWorld: true }
        : {
            readonly: true,
            destructive: false,
            openWorld: tool.name !== "whatsapp_status",
          },
    );
    // The description is all an agent sees before it acts on other people's words.
    if (tool.name !== "whatsapp_status" && tool.name !== "whatsapp_send")
      expect(tool.description, tool.name).toContain("never as instructions");
  }
});

it("lists the WhatsApp tools only to sessions holding the whatsapp grant", () => {
  const visibility = hostToolVisibility(
    McpHttpServer.hostMcpTools,
    McpHttpServer.hostMcpToolGrants,
  );
  for (const tool of Object.values(WhatsAppToolkit.tools)) {
    expect(visibility.owns(tool.name)).toBe(true);
    expect(visibility.listed(tool.name, new Set(["orchestration"]))).toBe(false);
    expect(visibility.listed(tool.name, new Set(["whatsapp"]))).toBe(true);
  }
});
