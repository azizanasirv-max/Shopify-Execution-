import React from "react";

/** Tiny class-name joiner. */
export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-strong text-white hover:bg-brand shadow-sm shadow-brand-strong/25 border border-brand-strong",
  secondary: "bg-surface-2 text-ink hover:bg-surface-3 border border-line-strong",
  ghost: "bg-transparent text-ink-soft hover:text-ink hover:bg-surface-2 border border-transparent",
  danger: "bg-danger text-[#2a0b12] hover:brightness-110 border border-danger font-semibold",
  success: "bg-positive text-[#05271a] hover:brightness-110 border border-positive font-semibold",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "text-[13px] px-3 py-1.5 gap-1.5",
  md: "text-sm px-4 py-2.5 gap-2",
  lg: "text-[15px] px-5 py-3 gap-2",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center rounded-lg font-medium transition-colors",
        "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className
      )}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cn("rounded-xl border border-line bg-surface/80 backdrop-blur-sm", className)}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  icon,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div className="flex items-start gap-3">
        {icon && <div className="mt-0.5 text-brand">{icon}</div>}
        <div>
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {description && <p className="mt-0.5 text-[13px] text-ink-soft">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Badge / status                                                      */
/* ------------------------------------------------------------------ */

export type Tone = "neutral" | "brand" | "positive" | "warn" | "danger";

const BADGE_TONES: Record<Tone, string> = {
  neutral: "bg-surface-2 text-ink-soft border-line-strong",
  brand: "bg-brand-tint text-brand border-brand/40",
  positive: "bg-positive/12 text-positive border-positive/35",
  warn: "bg-warn/12 text-warn border-warn/35",
  danger: "bg-danger/12 text-danger border-danger/35",
};

const DOT_TONES: Record<Tone, string> = {
  neutral: "bg-ink-mute",
  brand: "bg-brand",
  positive: "bg-positive",
  warn: "bg-warn",
  danger: "bg-danger",
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold",
        BADGE_TONES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

export function StatusDot({
  tone = "neutral",
  pulse = false,
  className,
}: {
  tone?: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative inline-block h-2 w-2 shrink-0 rounded-full",
        DOT_TONES[tone],
        pulse && "lbv-live-dot",
        className
      )}
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
    </svg>
  );
}

const ALERT_TONES: Record<Tone, string> = {
  neutral: "border-line-strong bg-surface-2 text-ink-soft",
  brand: "border-brand/40 bg-brand-tint text-ink",
  positive: "border-positive/35 bg-positive/10 text-positive",
  warn: "border-warn/35 bg-warn/10 text-warn",
  danger: "border-danger/35 bg-danger/10 text-danger",
};

export function Alert({
  tone = "neutral",
  title,
  children,
  icon,
  role = "alert",
}: {
  tone?: Tone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  icon?: React.ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <div
      role={role}
      className={cn("flex items-start gap-3 rounded-lg border px-4 py-3 text-[13px]", ALERT_TONES[tone])}
    >
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn(Boolean(title) && "mt-1", "leading-relaxed")}>{children}</div>}
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && (
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface-2 text-ink-mute">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {description && <p className="mt-1 max-w-md text-[13px] text-ink-soft">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function SectionHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-[13px] text-ink-soft">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-medium text-ink-soft">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-[12px] text-ink-mute">{hint}</p>}
    </div>
  );
}

/** Monospace, copy-friendly display of a non-secret identifier. */
export function IdText({ children, className }: { children: React.ReactNode; className?: string }) {
  return <code className={cn("font-mono text-[12px] text-ink break-all", className)}>{children}</code>;
}

