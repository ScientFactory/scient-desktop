import type { ProviderInstanceId } from "@t3tools/contracts";
import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { modelTestGuidance } from "./customModels";

export interface CustomModelTestNotice {
  readonly text: string;
  readonly error: boolean;
  /** The agent the Test ran through, so a retry uses it again. */
  readonly agent?: ProviderInstanceId;
}

/** A model row's recovery and Test actions. */
export function CustomModelRowActions({
  busy,
  testing,
  statuses,
  keyMissing,
  testAgents,
  notice,
  onCheckAgain,
  onReenterKey,
  onTest,
}: {
  busy: boolean;
  /** A Test of this model is running. */
  testing: boolean;
  /** Each attached agent's status label, when it has one. */
  statuses: ReadonlyArray<string | undefined>;
  /** An agent reports the connection's saved key missing (see `connectionKeyMissing`). */
  keyMissing: boolean;
  /** Agents the model can be tested through (see `modelTestAgents`). */
  testAgents: ReadonlyArray<{ readonly id: ProviderInstanceId; readonly name: string }>;
  notice: CustomModelTestNotice | null;
  onCheckAgain: () => void;
  onReenterKey: () => void;
  onTest: (agent: ProviderInstanceId) => void;
}) {
  return (
    <>
      {statuses.some((label) => label === "Needs setup" || label === "Check agent") ? (
        <Button size="xs" variant="ghost" disabled={busy} onClick={onCheckAgain}>
          Check again
        </Button>
      ) : null}
      {/* The key belongs to the connection: whatever any agent's status says, only this restores it. */}
      {keyMissing ? (
        <Button size="xs" variant="ghost" disabled={busy} onClick={onReenterKey}>
          Re-enter key
        </Button>
      ) : null}
      {testAgents.length > 0 && notice && !notice.error ? (
        <span
          role="status"
          className="flex h-7 shrink-0 items-center gap-1 px-2 text-sm font-medium text-success sm:h-6 sm:text-xs"
        >
          <CheckIcon className="size-4 sm:size-3.5" />
          {notice.text}
        </span>
      ) : (
        <>
          {testAgents.length > 0 && notice ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost-destructive"
                    disabled={busy}
                    aria-label={`Test failed. ${notice.text} Select to try again.`}
                    onClick={() =>
                      onTest(
                        testAgents.find((agent) => agent.id === notice.agent)?.id ??
                          testAgents[0]!.id,
                      )
                    }
                  />
                }
              >
                <CircleAlertIcon />
                Failed
                <span role="alert" className="sr-only">
                  {notice.text}
                </span>
              </TooltipTrigger>
              <TooltipPopup>{notice.text}</TooltipPopup>
            </Tooltip>
          ) : null}
          {/* A failure keeps the agent choice: the model may work through another agent. */}
          {testAgents.length > 1 ? (
            <Menu>
              <MenuTrigger render={<Button size="xs" variant="ghost" disabled={busy} />}>
                {testing ? "Testing…" : "Test"}
              </MenuTrigger>
              <MenuPopup align="end">
                {/* A group label needs its group: Base UI throws on one outside. */}
                <MenuGroup>
                  <MenuGroupLabel>Send a small request through</MenuGroupLabel>
                  {testAgents.map((agent) => (
                    <MenuItem key={agent.id} onClick={() => onTest(agent.id)}>
                      {agent.name}
                    </MenuItem>
                  ))}
                </MenuGroup>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>API charges may apply.</MenuGroupLabel>
                </MenuGroup>
              </MenuPopup>
            </Menu>
          ) : testAgents.length === 1 && !notice ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => onTest(testAgents[0]!.id)}
                  />
                }
              >
                {testing ? "Testing…" : "Test"}
              </TooltipTrigger>
              <TooltipPopup>
                Sends a small request through {testAgents[0]!.name}. API charges may apply.
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </>
      )}
    </>
  );
}

/** Shown in the row when Test is unavailable, so its absence is explained. */
export function CustomModelTestGuidance({
  testAgents,
  agents,
}: {
  testAgents: ReadonlyArray<{ readonly id: ProviderInstanceId }>;
  /** Every agent that can use custom models. */
  agents: ReadonlyArray<{ readonly name: string }>;
}) {
  return testAgents.length === 0 ? (
    <p className="text-xs text-muted-foreground">
      {modelTestGuidance(agents.map((agent) => agent.name))}
    </p>
  ) : null;
}
