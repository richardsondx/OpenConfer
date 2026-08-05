import type { ReactNode } from "react";

/** Inline help control — hover/focus reveals plain-language guidance. */
export function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="oc-tip">
      <button type="button" className="oc-tip-btn" aria-label={label} title={label}>
        ?
      </button>
      <span className="oc-tip-bubble" role="tooltip">
        {children}
      </span>
    </span>
  );
}
