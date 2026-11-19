import type { ProviderInstanceId } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
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
import { type ModelConnectionStatusKind, modelTestGuidance } from "./customModels";

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
  statuses: ReadonlyArray<ModelConnectionStatusKind | undefined>;
  /** An agent reports the connection's saved key missing (see `connectionKeyMissing`). */
  keyMissing: boolean;
  /** Agents the model can be tested through (see `modelTestAgents`). */
  testAgents: ReadonlyArray<{ readonly id: ProviderInstanceId; readonly name: string }>;
  notice: CustomModelTestNotice | null;
  onCheckAgain: () => void;
  onReenterKey: () => void;
  onTest: (agent: ProviderInstanceId) => void;
}) {
  const gt = useGT();
  return (
    <>
      {statuses.some((kind) => kind === "needs-setup" || kind === "check-agent") ? (
        <Button size="xs" variant="ghost" disabled={busy} onClick={onCheckAgain}>
          <T>Check again</T>
        </Button>
      ) : null}
      {/* The key belongs to the connection: whatever any agent's status says, only this restores it. */}
      {keyMissing ? (
        <Button size="xs" variant="ghost" disabled={busy} onClick={onReenterKey}>
          <T>Re-enter key</T>
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
                    aria-label={gt("Test failed. {reason} Select to try again.", {
                      reason: notice.text,
                    })}
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
                <T context="the model test failed">Failed</T>
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
                {testing ? gt("Testing…") : gt("Test", { $context: "verb, tests the model" })}
              </MenuTrigger>
              <MenuPopup align="end">
                {/* A group label needs its group: Base UI throws on one outside. */}
                <MenuGroup>
                  <MenuGroupLabel>
                    <T>Send a small request through</T>
                  </MenuGroupLabel>
                  {testAgents.map((agent) => (
                    <MenuItem key={agent.id} onClick={() => onTest(agent.id)}>
                      {agent.name}
                    </MenuItem>
                  ))}
                </MenuGroup>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>
                    <T>API charges may apply.</T>
                  </MenuGroupLabel>
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
                {testing ? gt("Testing…") : gt("Test", { $context: "verb, tests the model" })}
              </TooltipTrigger>
              <TooltipPopup>
                <T>
                  Sends a small request through <Var>{testAgents[0]!.name}</Var>. API charges may
                  apply.
                </T>
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
  const messages = useMessages();
  return testAgents.length === 0 ? (
    <p className="text-xs text-muted-foreground">
      {modelTestGuidance(
        agents.map((agent) => agent.name),
        messages,
      )}
    </p>
  ) : null;
}
