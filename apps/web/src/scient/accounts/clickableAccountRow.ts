import type { ComponentPropsWithoutRef } from "react";

export function clickableAccountRow(open: () => void): ComponentPropsWithoutRef<"div"> {
  const owns = (event: { target: EventTarget; currentTarget: HTMLElement }) =>
    event.target instanceof Element &&
    event.currentTarget.contains(event.target) &&
    !event.target.closest('button, a, input, [role="menuitem"], [data-slot="menu-trigger"]');
  return {
    role: "button",
    tabIndex: 0,
    className: "cursor-pointer hover:bg-accent/40",
    onClick: (event) => {
      if (owns(event)) open();
    },
    onKeyDown: (event) => {
      if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        open();
      }
    },
  };
}
