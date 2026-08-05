import type { ReactNode, ButtonHTMLAttributes } from "react";

export function Button({
  variant = "primary",
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button className={`btn btn-${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function Badge({
  variant = "default",
  live = false,
  children,
}: {
  variant?: "default" | "active" | "urgent" | "success" | "danger";
  /** Soft shimmer for ongoing states (e.g. In progress). */
  live?: boolean;
  children: ReactNode;
}) {
  const cls = [
    "badge",
    variant !== "default" ? `badge-${variant}` : "",
    live ? "badge-live" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return <span className={cls}>{children}</span>;
}

export function ContinuityMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 16 H12 M20 16 H28 M16 8 V24"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="3" fill="currentColor" />
    </svg>
  );
}
