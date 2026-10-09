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
  return system.some(
    (content) =>
      typeof content === "string" &&
      content.includes(
        "You are a helper that generates concise session titles for a session picker.",
      ),
  )
    ? "title"
    : "unexpected";
}
