import type * as React from "react";

import { cn } from "~/lib/utils";

import { formatKbdKeyLabel, Kbd, KbdGroup } from "./kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

interface KbdTooltipProps {
  children: React.ReactElement<Record<string, unknown>>;
  label: React.ReactNode;
  shortcut?: React.ReactNode | ReadonlyArray<React.ReactNode>;
  side?: React.ComponentProps<typeof TooltipPopup>["side"];
  sideOffset?: React.ComponentProps<typeof TooltipPopup>["sideOffset"];
  popupClassName?: string;
}

function KbdTooltip({
  children,
  label,
  shortcut,
  side = "top",
  sideOffset = 6,
  popupClassName,
}: KbdTooltipProps) {
  const shortcutItems = (
    shortcut == null ? [] : Array.isArray(shortcut) ? shortcut : [shortcut]
  ).filter((item) => item != null);

  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup
        side={side}
        sideOffset={sideOffset}
        className={cn("max-w-none text-left", popupClassName)}
      >
        <div className="flex items-center gap-2.5 whitespace-nowrap">
          <span className="font-medium text-foreground/90">{label}</span>
          {shortcutItems.length > 0 ? (
            <KbdGroup className="gap-1.5">
              {shortcutItems.map((item) => (
                <Kbd
                  key={typeof item === "string" ? item : String(item)}
                  className="h-5 min-w-5 rounded-md border border-border/70 bg-muted/72 px-1.5 text-[10px] text-muted-foreground/85 shadow-none"
                >
                  {formatKbdKeyLabel(item)}
                </Kbd>
              ))}
            </KbdGroup>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

export { KbdTooltip };
