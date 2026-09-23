"use client";

import type { ReactNode } from "react";
import { IconCopy } from "./ui/icons";
import { Dialog, useToast } from "./ui/overlay";
import { Button, buttonClass } from "./ui/primitives";

/**
 * Shows a one-time link (invitation, password reset) to hand over by
 * WhatsApp or copy-paste. Email is on hold, so this is the delivery path.
 * The WhatsApp text never includes dollar figures (brief §9).
 */
export function ShareLinkDialog({
  title,
  intro,
  url,
  whatsappText,
  onClose,
}: {
  title: string;
  intro: ReactNode;
  url: string;
  whatsappText: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const whatsapp = `https://wa.me/?text=${encodeURIComponent(`${whatsappText} ${url}`)}`;
  return (
    <Dialog open onClose={onClose} title={title} footer={<Button onClick={onClose}>Done</Button>}>
      <div className="flex flex-col gap-6">
        <div className="text-sm text-muted">{intro}</div>
        <div className="flex items-center gap-2 rounded-control border border-border bg-sunken p-3">
          <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{url}</code>
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(url);
              toast("success", "Link copied");
            }}
          >
            <IconCopy size={16} /> Copy
          </Button>
        </div>
        <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={buttonClass("accent", "md", "self-start")}>
          Send by WhatsApp
        </a>
      </div>
    </Dialog>
  );
}
