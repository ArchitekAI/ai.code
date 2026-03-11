import type * as React from "react";

import { cn, isMacPlatform } from "~/lib/utils";

function formatKbdKeyLabel(
  label: React.ReactNode,
  platform: string = typeof navigator === "undefined" ? "" : navigator.platform,
): React.ReactNode {
  if (typeof label !== "string") {
    return label;
  }

  const normalized = label.trim().toLowerCase();
  if (!isMacPlatform(platform)) {
    if (normalized === "command") return "Meta";
    return label;
  }

  switch (normalized) {
    case "cmd":
    case "command":
    case "meta":
      return "\u2318";
    case "ctrl":
    case "control":
      return "\u2303";
    case "shift":
      return "\u21e7";
    case "alt":
    case "option":
      return "\u2325";
    default:
      return label;
  }
}

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded bg-muted px-1 font-medium font-sans text-muted-foreground text-xs [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      data-slot="kbd"
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn("inline-flex items-center gap-1", className)}
      data-slot="kbd-group"
      {...props}
    />
  );
}

export { Kbd, KbdGroup, formatKbdKeyLabel };
