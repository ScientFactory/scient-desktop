import type { ScientSkillCatalogItem, ScientSkillInvocationPolicy } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { SettingsRow } from "../../components/settings/settingsLayout";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/utils";
import { OPENABLE_ROW_CLASS, openFromRow } from "./skillRowOpen";

const invocationPolicyLabel = (policy: ScientSkillInvocationPolicy): string =>
  policy === "automatic" ? msg("Agent access") : msg("$name only");

const displaySkillName = (name: string): string =>
  name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

export function SkillSettingsRow(props: {
  readonly skill: ScientSkillCatalogItem;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly status: ReactNode;
  readonly onOpen?: (() => void) | undefined;
  /** Buttons before the switch, such as a row's menu. */
  readonly actions?: ReactNode;
  readonly onUpdate: (patch: {
    readonly active?: boolean;
    readonly invocationPolicy?: ScientSkillInvocationPolicy;
  }) => void;
}) {
  const { disabled, onUpdate, pending, skill } = props;
  const gt = useGT();
  const m = useMessages();
  return (
    <SettingsRow
      className={cn(
        "sm:[&>div]:grid-cols-[minmax(0,1fr)_auto] [&>div>div>p]:max-w-none",
        props.onOpen && OPENABLE_ROW_CLASS,
      )}
      onClick={props.onOpen ? openFromRow(props.onOpen) : undefined}
      title={
        <span className="inline-flex items-center gap-2">
          {props.onOpen ? (
            <button
              type="button"
              className="cursor-pointer rounded-sm text-left outline-none focus-visible:outline-1 focus-visible:outline-solid focus-visible:outline-ring"
              onClick={props.onOpen}
            >
              {displaySkillName(skill.name)}
            </button>
          ) : (
            <span>{displaySkillName(skill.name)}</span>
          )}
          <Select
            value={skill.invocationPolicy}
            disabled={!skill.active || disabled}
            onValueChange={(value) =>
              onUpdate({ invocationPolicy: value as ScientSkillInvocationPolicy })
            }
          >
            <SelectTrigger
              size="sm"
              variant="ghost"
              className="w-fit min-w-0"
              icon={<ChevronDownIcon className="size-3 opacity-70" strokeWidth={2.25} />}
              aria-label={gt("{skill} use", { skill: skill.name })}
            >
              <SelectValue>
                {skill.active
                  ? m(invocationPolicyLabel(skill.invocationPolicy))
                  : gt("Deactivated")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="automatic">{gt("Agent access")}</SelectItem>
              <SelectItem value="explicit">{gt("$name only")}</SelectItem>
            </SelectPopup>
          </Select>
        </span>
      }
      description={skill.description}
      status={props.status}
      control={
        <span className="flex items-center gap-1">
          {props.actions}
          <Switch
            checked={skill.active}
            motion="none"
            disabled={pending || disabled}
            aria-label={gt("Make {skill} available", { skill: skill.name })}
            onCheckedChange={(checked) => onUpdate({ active: Boolean(checked) })}
          />
        </span>
      }
    />
  );
}
