// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { expect, it, vi } from "vite-plus/test";

import { scientAgentTarget } from "../scient/ScientAgentTarget.ts";
import {
  SCIENT_CONNECTOR_LOAD_MODE_ENV,
  scientConnectorLoadMode,
} from "../scient/ScientAgentToolLoading.ts";
import { ompScientExtensionSource } from "./OmpScientExtension.ts";
import { ompTarget } from "./OmpTarget.ts";

it.each([
  [scientAgentTarget, "0.1.3", "19.1.1", "essential"],
  [ompTarget, "18.17.0", "18.17.0", "essential"],
  [scientAgentTarget, "1.0.0", "19.0.9", "devices"],
  [ompTarget, "19.1.0", "19.1.0", "commands"],
  [scientAgentTarget, "1.0.0", "19.1.1", "commands"],
] as const)(
  "selects discovery for $0.driverKind $1 on OMP $2",
  async (target, version, runtimeVersion, expected) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-command-guidance-"));
    const bootstrap = NodePath.join(root, "bootstrap.json");
    const modulePath = NodePath.join(root, "extension.mjs");
    try {
      NodeFS.writeFileSync(
        bootstrap,
        JSON.stringify({
          awareness: "Workspace",
          endpoint: "https://fixture.invalid",
          authorization: "Bearer fixture",
        }),
      );
      vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
        const { id, method } = JSON.parse(String(init.body)) as { id?: number; method: string };
        if (method === "notifications/initialized") return new Response(null, { status: 202 });
        const result =
          method === "tools/list"
            ? {
                tools: ["scient_compute_run", "scient_connector_list"].map((name) => ({
                  name,
                  inputSchema: { type: "object" },
                })),
              }
            : { protocolVersion: "2025-06-18" };
        return Response.json({ jsonrpc: "2.0", id, result });
      });
      NodeFS.writeFileSync(modulePath, ompScientExtensionSource(target, bootstrap));
      vi.stubEnv(
        SCIENT_CONNECTOR_LOAD_MODE_ENV,
        scientConnectorLoadMode(target, { version, runtimeVersion }),
      );
      for (const load of [1, 2]) {
        const extension = (await import(
          /* @vite-ignore */ `${NodeURL.pathToFileURL(modulePath).href}?load=${load}`
        )) as { default: (api: unknown) => Promise<void> };
        type Start = (event: { systemPrompt: string[] }) => { systemPrompt: string[] };
        const handlers = new Map<string, Start>();
        const modes = new Map<string, string>();
        await extension.default({
          registerTool: (tool: { name: string; loadMode: string }) =>
            modes.set(tool.name, tool.loadMode),
          on: (name: string, handler: Start) => handlers.set(name, handler),
          registerCommand: () => undefined,
        });
        expect(modes.get("scient_compute_run")).toBe("essential");
        expect(modes.get("scient_connector_list")).toBe(
          expected === "essential" ? "essential" : "discoverable",
        );
        for (const turn of ["start", "continue"]) {
          const prompt = handlers.get("before_agent_start")!({ systemPrompt: [turn] }).systemPrompt;
          expect(prompt[0]).toBe(turn);
          if (expected === "essential") expect(prompt).toEqual([turn, "Workspace"]);
          if (expected === "devices") {
            expect(prompt[1]).toContain("write JSON arguments to xd://<name>");
            expect(prompt[1]).not.toContain("--help");
          }
          if (expected === "commands") {
            expect(prompt[1]).toContain("command catalog");
            expect(prompt[1]).toContain("<command> --help");
            expect(prompt[1]).toContain("-j '<json>'");
            expect(prompt[1]).not.toContain("xd://");
          }
        }
      }
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
