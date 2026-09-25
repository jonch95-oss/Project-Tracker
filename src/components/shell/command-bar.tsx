"use client";

import { useEffect, useState } from "react";
import { Dialog } from "../ui/overlay";
import { SearchPanel, type Destination } from "./search-panel";

/** Opens search from anywhere: ⌘K / Ctrl+K, or "/" when not typing in a field. */
export function useCommandBar(enabled = true): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // Without search (investors), the browser keeps its own shortcuts.
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
  return [open, setOpen];
}

export function CommandBar({ open, onClose, destinations }: { open: boolean; onClose: () => void; destinations: Destination[] }) {
  return (
    <Dialog open={open} onClose={onClose} title="Search" size="lg">
      {/* Mounted only while open, so each opening starts empty with the cursor in the box. */}
      {open && <SearchPanel destinations={destinations} onNavigate={onClose} />}
    </Dialog>
  );
}
