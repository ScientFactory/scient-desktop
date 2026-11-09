import { MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuSeparator } from "~/components/ui/menu";
import { DockCommandRadioItem } from "./dockChrome";
import { FONT_FAMILIES, FONT_SIZES, type FontFamilyName, type FontSizeName } from "./fontChoices";

const DEFAULT_CHOICE = "default";

/**
 * Content of `Text > Font / Size`, identical in both editors. A null value
 * means the document default; choosing "Default" removes the style.
 */
export function FontMenuItems(props: {
  readonly family: string | null;
  readonly size: string | null;
  readonly disabled: boolean;
  readonly onFamily: (family: FontFamilyName | null) => void;
  readonly onSize: (size: FontSizeName | null) => void;
}) {
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>Font</MenuGroupLabel>
        <MenuRadioGroup value={props.family ?? DEFAULT_CHOICE}>
          <DockCommandRadioItem
            value={DEFAULT_CHOICE}
            disabled={props.disabled}
            onClick={() => props.onFamily(null)}
          >
            Default
          </DockCommandRadioItem>
          {FONT_FAMILIES.map((family) => (
            <DockCommandRadioItem
              key={family.name}
              value={family.name}
              disabled={props.disabled}
              onClick={() => props.onFamily(family.name)}
            >
              {family.label}
            </DockCommandRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup>
        <MenuGroupLabel>Size</MenuGroupLabel>
        <MenuRadioGroup value={props.size ?? DEFAULT_CHOICE}>
          <DockCommandRadioItem
            value={DEFAULT_CHOICE}
            disabled={props.disabled}
            onClick={() => props.onSize(null)}
          >
            Default
          </DockCommandRadioItem>
          {FONT_SIZES.map((size) => (
            <DockCommandRadioItem
              key={size.name}
              value={size.name}
              disabled={props.disabled}
              onClick={() => props.onSize(size.name)}
            >
              {size.label}
            </DockCommandRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
    </>
  );
}
