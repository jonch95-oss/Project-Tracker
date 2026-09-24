"use client";

import { useState, useSyncExternalStore } from "react";
import { IconPin } from "@/components/ui/icons";
import { locationOn, setLocationOn } from "@/lib/camera";
import { cn } from "@/lib/cn";

const noSubscribe = () => () => {};

/** "Add location" for photos taken with the camera (one setting per phone, shown wherever a photo can be taken). */
export function LocationToggle({ className }: { className?: string }) {
  const stored = useSyncExternalStore(noSubscribe, locationOn, () => false);
  const [choice, setChoice] = useState<boolean | null>(null);
  const on = choice ?? stored;
  return (
    <label
      className={cn(
        "flex h-10 cursor-pointer items-center gap-2 rounded-control px-2 text-[13px] text-muted",
        className,
      )}
    >
      <input
        type="checkbox"
        className="size-4 accent-[var(--primary)]"
        checked={on}
        onChange={(e) => {
          setChoice(e.target.checked);
          setLocationOn(e.target.checked);
        }}
      />
      <IconPin size={16} /> Add location
    </label>
  );
}
