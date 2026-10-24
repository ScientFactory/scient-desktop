// SCIENT-FORK:START — PR wake-up copy uses the host identity, retaining the MCP server name.
const pullRequestLinkingInstructions = (productName: string) => `<pull_request_linking>
When the MCP server named t3-code exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through your host's CLI (including its stack commands) or its API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. As a delegated child task, do not watch or poll PRs; return PR URLs, head SHA, and pending review/check state to your parent. Otherwise, when asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: ${productName} wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When monitoring is done and you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.
</pull_request_linking>`;
// SCIENT-FORK:END

// SCIENT-FORK:START — expose the host-neutral runtime input type for app-owned prompt copy.
/** Shared runtime context; omit model and effort when the harness manages them dynamically. */
export interface RuntimeInstructionsInput {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** Product identity is supplied by the host; the generic provider package defaults to T3 Code. */
  readonly productName?: string | undefined;
  /** Host-owned product policy may replace the generic PR-linking instructions. */
  readonly pullRequestLinkingInstructions?: string | undefined;
}
// SCIENT-FORK:END

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 */
// SCIENT-FORK:START — accept the host-extensible input at the shared formatter signature.
export function buildRuntimeInstructions(runtime: RuntimeInstructionsInput): string {
  // SCIENT-FORK:END
  // SCIENT-FORK:START — keep T3 defaults while allowing an owning host override.
  const productName = toSingleLine(runtime.productName ?? "T3 Code");
  // SCIENT-FORK:END
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  // SCIENT-FORK:START — append host-owned product copy when supplied.
  return `<runtime_info>In case you're asked: you are running in ${productName} through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${runtime.pullRequestLinkingInstructions ?? pullRequestLinkingInstructions(productName)}`;
  // SCIENT-FORK:END
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
