"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconAlert, IconCheckCircle, IconClose } from "./icons";

/* ------------------------------------------------------------------ */
/* Dialog: native <dialog> for focus trapping, Esc and inert background */
/* ------------------------------------------------------------------ */

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** When false, Esc and backdrop clicks don't close it (e.g. one-time backup codes). */
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const width = { sm: "max-w-md", md: "max-w-lg", lg: "max-w-2xl" }[size];
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        if (!dismissible) e.preventDefault();
      }}
      onClick={(e) => {
        if (dismissible && e.target === ref.current) onClose();
      }}
      aria-labelledby={titleId}
      className={cn(
        "m-auto w-[calc(100%-32px)] rounded-card border border-border bg-surface p-0 text-text shadow-overlay",
        "max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none",
        width,
      )}
    >
      <div className="flex max-h-[85dvh] flex-col">
        <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-6 sm:px-8 sm:pt-8">
          <div>
            <h2 id={titleId} className="serif text-heading">
              {title}
            </h2>
            {description && <p className="mt-2 text-sm text-muted">{description}</p>}
          </div>
          {dismissible && (
            <button type="button" onClick={onClose} className="-mr-2 -mt-1 rounded-control p-2 text-muted hover:bg-sunken hover:text-text" aria-label="Close">
              <IconClose size={20} />
            </button>
          )}
        </header>
        <div className="overflow-y-auto px-6 pb-6 sm:px-8">{children}</div>
        {footer && <footer className="safe-bottom flex flex-wrap justify-end gap-2 border-t border-border px-6 py-4 sm:px-8">{footer}</footer>}
      </div>
    </dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Confirm: names the consequence before a high-impact action           */
/* ------------------------------------------------------------------ */

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      size="sm"
      title={title}
      footer={
        <>
          <button type="button" onClick={onCancel} className="h-10 rounded-control px-4 text-sm font-medium hover:bg-sunken">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={
              danger
                ? "h-10 rounded-control border border-blocked/40 bg-blocked px-4 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
                : "h-10 rounded-control bg-primary px-4 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
            }
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-[15px] text-muted">{body}</div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

interface Toast {
  id: number;
  tone: "success" | "error";
  message: string;
}

const ToastContext = createContext<(tone: Toast["tone"], message: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast["tone"], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 7000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(88px+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4 lg:bottom-8 lg:items-end lg:px-8"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className="pointer-events-auto flex max-w-md items-center gap-3 rounded-panel border border-border bg-surface px-4 py-3 text-sm shadow-overlay"
          >
            {t.tone === "success" ? <IconCheckCircle size={18} className="shrink-0 text-done" /> : <IconAlert size={18} className="shrink-0 text-blocked" />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
