"use client";

import { whatsappUrl } from "@/core/notify";
import { cn } from "@/lib/cn";
import { IconShare } from "./ui/icons";
import { buttonClass } from "./ui/primitives";

/**
 * Opens WhatsApp on the person's own phone with the message typed in; they
 * press send (brief §9: free, no API). Dollar figures are stripped.
 */
export function WhatsAppShare({ text, href, label = "WhatsApp", compact = false, className }: { text: string; href?: string | null; label?: string; compact?: boolean; className?: string }) {
  const link = href ? (typeof window === "undefined" ? href : new URL(href, window.location.origin).href) : undefined;
  return (
    <a
      href={whatsappUrl(text, link)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={compact ? `Share by WhatsApp: ${text}` : undefined}
      title="Share by WhatsApp"
      className={compact ? cn("inline-flex size-9 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-text", className) : buttonClass("secondary", "sm", className)}
      onClick={(e) => e.stopPropagation()}
    >
      <IconShare size={compact ? 18 : 16} />
      {!compact && label}
    </a>
  );
}
