import type { OrchestrationV2ProviderGoal } from "@t3tools/contracts";
import { presentProviderGoal } from "@t3tools/client-runtime/state/thread-execution";
import { ListChecksIcon, TargetIcon, XIcon } from "lucide-react";
import { memo } from "react";

import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

/** A composer mode: the next message sets a goal or asks for a plan. */
export type ComposerMode = "goal" | "plan";

/** What the thread knows about its goal and plan mode, from ChatView. */
export interface ComposerModeChipsThreadState {
  readonly goal: OrchestrationV2ProviderGoal | null;
  readonly planMode: boolean;
  /** Sends a goal or plan command as its own turn; absent before the thread exists. */
  readonly onSendCommand: ((text: string, failureMessage: string) => Promise<void>) | undefined;
}

const MODE_COMMANDS: Record<ComposerMode, string> = { goal: "/goal", plan: "/plan" };

/** `text` as the command the mode sends; text that is empty or already a command is left alone. */
export function composerModePrompt(mode: ComposerMode, text: string): string {
  const trimmed = text.trimStart();
  if (trimmed === "" || trimmed.startsWith("/")) return text;
  return `${MODE_COMMANDS[mode]} ${trimmed}`;
}

export const COMPOSER_MODE_PLACEHOLDERS: Record<ComposerMode, string> = {
  goal: "Describe the goal. The agent keeps working until it is done.",
  plan: "Describe what to plan. Nothing changes until you approve the plan.",
};

/** Short state for the chip; the full title stays on the goal row in the conversation. */
function goalChipLabel(goal: OrchestrationV2ProviderGoal, working: boolean): string {
  switch (goal.status) {
    case "active":
      return working ? "Goal · running" : "Goal set";
    case "paused":
      return "Goal paused";
    case "complete":
      return "Goal done";
    default:
      return "Goal stopped";
  }
}

export const ComposerModeChips = memo(function ComposerModeChips(props: {
  size?: ComposerControlSize;
  hidden?: boolean;
  supportsGoal: boolean;
  supportsPlan: boolean;
  /** The mode the next message is sent in, if any. */
  mode: ComposerMode | null;
  onModeChange: (mode: ComposerMode | null) => void;
  goal: OrchestrationV2ProviderGoal | null;
  working: boolean;
  /** The agent is planning: it changes nothing until a plan is approved. */
  planMode: boolean;
  /** Sends a goal or plan command as its own turn; absent before the thread exists. */
  onSendCommand: ((text: string, failureMessage: string) => Promise<void>) | undefined;
}) {
  // Small chips: they sit beside the attach button, not with the model picker.
  const size = props.size ?? "xs";
  const composerMenuProps = useComposerMenuProps();
  const [goalMenuOpen, setGoalMenuOpen] = useComposerMenuState(props.hidden);
  const [planMenuOpen, setPlanMenuOpen] = useComposerMenuState(props.hidden);
  const goal = props.goal;
  const onSendCommand = props.onSendCommand;

  // As tall as the attach button beside them, with the small label and icon.
  const chipClassName = "sm:h-7";
  const modeChip = (mode: ComposerMode, label: string, icon: typeof TargetIcon) => (
    <ComposerControl
      size={size}
      className={chipClassName}
      aria-pressed
      aria-label={`${label}: your next message is sent as a ${mode}. Click to cancel.`}
      onClick={() => props.onModeChange(null)}
    >
      <ComposerControlIcon icon={icon} size={size} />
      <span data-composer-control-label className="max-sm:sr-only">
        {label}
      </span>
      <XIcon aria-hidden="true" className="size-3 opacity-70" />
    </ComposerControl>
  );

  // A chip shows only while it means something: a mode picked from the / menu, a goal still
  // being worked on, or plan mode on in the agent.
  const goalChip = !props.supportsGoal ? null : props.mode === "goal" ? (
    modeChip("goal", goal === null ? "Goal" : "New goal", TargetIcon)
  ) : goal === null || goal.status === "complete" || onSendCommand === undefined ? null : (
    <Menu open={goalMenuOpen} onOpenChange={setGoalMenuOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            className={chipClassName}
            aria-pressed={goal.status === "active"}
            aria-label={`${presentProviderGoal(goal, props.working).title}: ${goal.objective}`}
          />
        }
      >
        <ComposerControlIcon icon={TargetIcon} size={size} />
        <span data-composer-control-label className="max-sm:sr-only">
          {goalChipLabel(goal, props.working)}
        </span>
      </MenuTrigger>
      <MenuPopup align="start" className="max-w-80" {...composerMenuProps}>
        <div className="px-2 py-1.5 text-muted-foreground text-xs">{goal.objective}</div>
        <MenuSeparator />
        {presentProviderGoal(goal, props.working).canResume && !props.working ? (
          <MenuItem onClick={() => void onSendCommand("/goal resume", "Failed to resume goal.")}>
            Resume goal
          </MenuItem>
        ) : null}
        <MenuItem onClick={() => props.onModeChange("goal")}>Set a new goal</MenuItem>
        <MenuItem onClick={() => void onSendCommand("/goal clear", "Failed to clear goal.")}>
          Clear goal
        </MenuItem>
      </MenuPopup>
    </Menu>
  );

  const planChip = !props.supportsPlan ? null : props.mode === "plan" ? (
    modeChip("plan", "Plan", ListChecksIcon)
  ) : !props.planMode || onSendCommand === undefined ? null : (
    <Menu open={planMenuOpen} onOpenChange={setPlanMenuOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            className={chipClassName}
            aria-pressed
            aria-label="Planning: the agent changes nothing until you approve a plan"
          />
        }
      >
        <ComposerControlIcon icon={ListChecksIcon} size={size} />
        <span data-composer-control-label className="max-sm:sr-only">
          Planning
        </span>
      </MenuTrigger>
      <MenuPopup align="start" {...composerMenuProps}>
        <MenuItem onClick={() => void onSendCommand("/plan off", "Failed to leave plan mode.")}>
          Leave plan mode
        </MenuItem>
      </MenuPopup>
    </Menu>
  );

  if (goalChip === null && planChip === null) return null;
  return (
    <div data-composer-mode-chips className="flex shrink-0 items-center gap-0.5">
      {goalChip}
      {planChip}
    </div>
  );
});
