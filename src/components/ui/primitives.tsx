import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { IconAlert, IconBlocked, IconCheckCircle, IconCircle, IconClock } from "./icons";

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "accent";
type ButtonSize = "sm" | "md" | "lg";

const buttonBase =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-[background-color,border-color,color,transform] duration-150 ease-quiet disabled:cursor-not-allowed disabled:opacity-50 active:translate-y-px select-none";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-on-primary hover:opacity-90",
  accent: "bg-accent text-on-accent hover:opacity-90",
  secondary: "border border-border-strong bg-surface text-text hover:border-text/40 hover:bg-sunken",
  ghost: "text-text hover:bg-sunken",
  danger: "border border-blocked/40 bg-surface text-blocked-text hover:bg-blocked-tint",
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-8 rounded-control px-3 text-[13px]",
  md: "h-10 rounded-control px-4 text-sm",
  lg: "h-12 rounded-control px-6 text-[15px]",
};

export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", extra?: string) {
  return cn(buttonBase, buttonVariants[variant], buttonSizes[size], extra);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, disabled, className, children, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass(variant, size, className)}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("size-4 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Form controls                                                       */
/* ------------------------------------------------------------------ */

const controlBase =
  "w-full rounded-control border border-border-strong bg-surface px-3 text-[15px] text-text placeholder:text-faint transition-colors duration-150 hover:border-text/30 focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus aria-[invalid=true]:border-blocked";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(controlBase, "h-11", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(controlBase, "min-h-24 py-2.5 leading-relaxed", className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...props }, ref) {
  return (
    <div className="relative">
      <select ref={ref} className={cn(controlBase, "h-11 appearance-none pr-9", className)} {...props}>
        {children}
      </select>
      <svg className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </div>
  );
});

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-text">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="flex items-center gap-1.5 text-[13px] text-blocked-text">
          <IconAlert size={14} /> {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-[13px] text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  id: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-text">
          {label}
        </label>
        {description && <p className="text-[13px] text-muted">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors duration-200 ease-quiet disabled:opacity-50",
          checked ? "border-primary bg-primary" : "border-border-strong bg-sunken",
        )}
      >
        <span
          className={cn(
            "inline-block size-4 rounded-full transition-transform duration-200 ease-quiet",
            checked ? "translate-x-[19px] bg-on-primary" : "translate-x-[3px] bg-text/40",
          )}
        />
        <span className="sr-only">{checked ? "On" : "Off"}</span>
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Surfaces                                                            */
/* ------------------------------------------------------------------ */

export function Card({ className, children, as: As = "div" }: { className?: string; children: ReactNode; as?: "div" | "section" | "article" }) {
  return <As className={cn("rounded-card border border-border bg-surface", className)}>{children}</As>;
}

export function Panel({ title, description, actions, children, className }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-card border border-border bg-surface", className)}>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-5 sm:px-8">
        <div className="min-w-0">
          <h2 className="serif text-[22px] leading-7">{title}</h2>
          {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div className="px-6 py-6 sm:px-8">{children}</div>
    </section>
  );
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-col gap-6 sm:mb-12 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-3">{eyebrow}</p>}
        <h1 className="serif text-[40px] leading-[44px] sm:text-[56px] sm:leading-[60px]">{title}</h1>
        {description && <p className="mt-3 max-w-2xl text-[15px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Status: always icon + label, never color alone                      */
/* ------------------------------------------------------------------ */

export type Tone = "done" | "attention" | "blocked" | "neutral" | "accent";

const toneClass: Record<Tone, string> = {
  done: "bg-done-tint text-done-text",
  attention: "bg-attention-tint text-attention-text",
  blocked: "bg-blocked-tint text-blocked-text",
  neutral: "bg-neutral-tint text-neutral-text",
  accent: "bg-accent-tint text-accent-text",
};

const toneIcon: Record<Tone, (p: { size?: number }) => ReactNode> = {
  done: IconCheckCircle,
  attention: IconClock,
  blocked: IconBlocked,
  neutral: IconCircle,
  accent: IconCircle,
};

export function StatusPill({ tone, children, icon = true, className }: { tone: Tone; children: ReactNode; icon?: boolean; className?: string }) {
  const I = toneIcon[tone];
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12px] font-medium leading-none", toneClass[tone], className)}>
      {icon && <I size={13} />}
      {children}
    </span>
  );
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-full border border-border px-2.5 text-[12px] font-medium text-muted", className)}>{children}</span>
  );
}

export function Avatar({ name, size = 32, className }: { name: string; size?: number; className?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <span
      aria-hidden="true"
      className={cn("serif inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-stone text-text", className)}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {initials}
    </span>
  );
}

/** Horizontal usage meter; tone follows the level, with a text label beside it. */
export function Meter({ valueBps, tone, label }: { valueBps: number | null; tone: Tone; label: string }) {
  const pct = valueBps === null ? 0 : Math.min(100, valueBps / 100);
  const bar: Record<Tone, string> = {
    done: "bg-done",
    attention: "bg-attention",
    blocked: "bg-blocked",
    neutral: "bg-neutral",
    accent: "bg-accent",
  };
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={valueBps === null ? undefined : Math.round(pct)}
      aria-valuetext={valueBps === null ? "Not measured" : `${pct.toFixed(0)}%`}
      className="relative h-1.5 w-full overflow-hidden rounded-full bg-sunken"
    >
      <div className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-quiet", bar[tone])} style={{ width: `${pct}%` }} />
      {/* 70% warning tick */}
      <div className="absolute inset-y-0 w-px bg-text/25" style={{ left: "70%" }} aria-hidden="true" />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("rounded-control bg-sunken", className)}
      style={{
        backgroundImage: "linear-gradient(90deg, transparent, color-mix(in oklab, var(--surface) 70%, transparent), transparent)",
        backgroundSize: "400px 100%",
        backgroundRepeat: "no-repeat",
        animation: "shimmer 1.4s var(--ease) infinite",
      }}
    />
  );
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cn("border-0 border-t border-border", className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border-strong bg-surface px-1 font-mono text-[11px] text-muted">{children}</kbd>;
}
