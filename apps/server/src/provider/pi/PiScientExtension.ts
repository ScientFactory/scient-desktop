// @effect-diagnostics globalFetch:off
/** Runs in Pi, without Scient's Effect runtime or dependencies. */
interface PiExtensionApi {
  on(event: "before_agent_start", handler: (event: { systemPrompt: string }) => unknown): void;
  on(
    event: "tool_result",
    handler: (event: { toolName: string; details?: unknown }) => unknown,
  ): void;
  registerCommand(
    name: string,
    command: {
      description: string;
      handler: (
        _args: string,
        ctx: { ui: { notify(message: string, kind: string): void } },
      ) => Promise<void>;
    },
  ): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (
      id: string,
      args: unknown,
      signal?: AbortSignal,
    ) => Promise<{
      content: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      >;
      details: unknown;
    }>;
  }): void;
}

export async function piScientExtension(pi: PiExtensionApi): Promise<void> {
  const endpoint = process.env.SCIENT_PI_MCP_ENDPOINT;
  const authorization = process.env.SCIENT_PI_MCP_AUTHORIZATION;
  const awareness = process.env.SCIENT_PI_AWARENESS ?? "";
  delete process.env.SCIENT_PI_MCP_ENDPOINT;
  delete process.env.SCIENT_PI_MCP_AUTHORIZATION;
  delete process.env.SCIENT_PI_AWARENESS;
  let nextId = 0;
  let sessionId: string | undefined;
  let protocolVersion = "2025-06-18";
  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;

  async function request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    notification = false,
  ): Promise<unknown> {
    if (!endpoint || !authorization) throw new Error("Scient tool connection is unavailable.");
    const id = ++nextId;
    const timeout = AbortSignal.timeout(180_000);
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization,
        "mcp-protocol-version": protocolVersion,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`Scient tool connection returned HTTP ${response.status}.`);
    const receivedSession = response.headers.get("mcp-session-id");
    if (receivedSession) sessionId = receivedSession;
    if (notification) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.body) throw new Error("Scient tool connection returned an empty response.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const sse = response.headers.get("content-type")?.includes("text/event-stream") === true;
    let buffer = "";
    let bytes = 0;
    const result = (json: string) => {
      const envelope = record(JSON.parse(json));
      if (envelope?.id !== id) return undefined;
      if (envelope.error) throw new Error("Scient rejected the tool request.");
      return { value: envelope.result };
    };
    try {
      while (true) {
        const chunk = await reader.read();
        bytes += chunk.value?.byteLength ?? 0;
        if (bytes > 16 * 1024 * 1024)
          throw new Error("Scient tool response exceeded its size limit.");
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        if (sse) {
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/u.exec(buffer)) !== null) {
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            const data = frame
              .split(/\r?\n/u)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /u, ""))
              .join("\n");
            if (data) {
              const parsed = result(data);
              if (parsed) return parsed.value;
            }
          }
        }
        if (chunk.done) break;
      }
      if (!sse) {
        const parsed = result(buffer);
        if (parsed) return parsed.value;
      }
      throw new Error("Scient tool response did not match its request.");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  const toolNames: string[] = [];
  if (endpoint || authorization) {
    const initialized = record(
      await request("initialize", {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "scient-pi", version: "1" },
      }),
    );
    if (typeof initialized?.protocolVersion === "string")
      protocolVersion = initialized.protocolVersion;
    await request("notifications/initialized", {}, undefined, true);
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const listed = record(await request("tools/list", cursor ? { cursor } : {}));
      if (!Array.isArray(listed?.tools))
        throw new Error("Scient returned an invalid tool catalog.");
      for (const value of listed.tools) {
        const tool = record(value);
        const parameters = record(tool?.inputSchema);
        if (typeof tool?.name !== "string" || !parameters || toolNames.includes(tool.name))
          throw new Error("Scient returned an invalid or duplicate tool.");
        const name = tool.name;
        toolNames.push(name);
        pi.registerTool({
          name,
          label: name,
          description: typeof tool.description === "string" ? tool.description : name,
          parameters,
          async execute(_id, args, signal) {
            const output = record(await request("tools/call", { name, arguments: args }, signal));
            if (!output || !Array.isArray(output.content))
              throw new Error("Scient returned an invalid tool result.");
            const content: Array<
              { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
            > = [];
            for (const value of output.content) {
              const part = record(value);
              if (part?.type === "text" && typeof part.text === "string")
                content.push({ type: "text", text: part.text });
              else if (
                part?.type === "image" &&
                typeof part.data === "string" &&
                typeof part.mimeType === "string"
              )
                content.push({ type: "image", data: part.data, mimeType: part.mimeType });
              else content.push({ type: "text", text: JSON.stringify(value) });
            }
            if (output.structuredContent !== undefined)
              content.push({ type: "text", text: JSON.stringify(output.structuredContent) });
            if (output.isError === true)
              content.unshift({ type: "text", text: "Scient tool reported an error:" });
            return { content, details: output };
          },
        });
      }
      cursor = typeof listed.nextCursor === "string" ? listed.nextCursor : undefined;
      if (!cursor) break;
      if (seen.has(cursor) || page === 99)
        throw new Error("Scient tool catalog pagination did not finish.");
      seen.add(cursor);
    }
  }
  pi.on("tool_result", (event) => {
    if (toolNames.includes(event.toolName) && record(event.details)?.isError === true)
      return { isError: true };
    return undefined;
  });
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${awareness}`,
  }));
  pi.registerCommand("scient-status", {
    description: "Show the Scient connection for this Pi session",
    async handler(_args, ctx) {
      ctx.ui.notify(
        `Scient connected: ${toolNames.length} tools. Full access; no native sandbox.`,
        "info",
      );
    },
  });
}

export const piScientExtensionSource = () => `export default ${piScientExtension.toString()};\n`;
