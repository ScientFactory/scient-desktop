/** Model traffic owned by the runtime fixtures, independently of arrival order. */
export function classifyDroidRuntimeTestRequest(
  request: Record<string, unknown>,
): "agent" | "title" | "unexpected" {
  if (Array.isArray(request.tools) && request.tools.length > 0) return "agent";
  const messages = request.messages ?? request.input;
  const system = Array.isArray(messages)
    ? messages.flatMap((message: unknown) => {
        if (typeof message !== "object" || message === null) return [];
        if (!("role" in message) || message.role !== "system") return [];
        return "content" in message ? [message.content] : [];
      })
    : [];
  system.push(request.system, request.instructions);
  const text = system.flatMap((content: unknown) => {
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.flatMap((block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      (block.type === "text" || block.type === "input_text") &&
      "text" in block &&
      typeof block.text === "string"
        ? [block.text]
        : [],
    );
  });
  return text.some(
    (content) =>
      typeof content === "string" &&
      content.includes(
        "You are a helper that generates concise session titles for a session picker.",
      ),
  )
    ? "title"
    : "unexpected";
}
