import type { ScientSkillCatalogItem, ScientSkillInvocationPolicy } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";

import { SettingsRow } from "../../components/settings/settingsLayout";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";

const invocationPolicyLabel = (policy: ScientSkillInvocationPolicy): string =>
  policy === "automatic" ? "Agent access" : "$name only";

const displaySkillName = (name: string): string =>
  name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

export function SkillSettingsRow(props: {
  readonly skill: ScientSkillCatalogItem;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly status: string;
  readonly onUpdate: (patch: {
    readonly active?: boolean;
    readonly invocationPolicy?: ScientSkillInvocationPolicy;
  }) => void;
}) {
  const { disabled, onUpdate, pending, skill } = props;
  return (
    <SettingsRow
      className="sm:[&>div]:grid-cols-[minmax(0,1fr)_5rem] [&>div>div>p]:max-w-none"
      title={
        <span className="inline-flex items-center gap-2">
          <span>{displaySkillName(skill.name)}</span>
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
              className="w-fit min-w-0 gap-1.5"
              icon={<ChevronDownIcon className="size-3 opacity-70" strokeWidth={2.25} />}
              aria-label={`${skill.name} use`}
            >
              <SelectValue>
                {skill.active ? invocationPolicyLabel(skill.invocationPolicy) : "Deactivated"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="automatic">Agent access</SelectItem>
              <SelectItem value="explicit">$name only</SelectItem>
            </SelectPopup>
          </Select>
        </span>
      }
      description={skill.description}
      status={props.status}
      control={
        <Switch
          checked={skill.active}
          disabled={pending || disabled}
          aria-label={`Make ${skill.name} available`}
          onCheckedChange={(checked) => onUpdate({ active: Boolean(checked) })}
        />
      }
    />
  );
}
