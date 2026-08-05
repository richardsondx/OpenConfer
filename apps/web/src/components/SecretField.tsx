import { useEffect, useId, useRef, useState } from "react";

const SAVED_MASK = "••••••••••••••";

export function SecretField({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  savedPreview,
  onReveal,
  readOnly = false,
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Short note under the label (e.g. local default). */
  hint?: string;
  /** When a secret is already on file, fill the field with a mask. */
  savedPreview?: string;
  /** Fetch the complete saved value only when the operator explicitly reveals it. */
  onReveal?: () => Promise<string>;
  /** Display a known secret with Show/Hide; typing is disabled. */
  readOnly?: boolean;
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const inputRef = useRef<HTMLInputElement>(null);
  const [visible, setVisible] = useState(false);
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const previousValue = useRef(value);
  const showingSaved = Boolean(savedPreview) && !value;

  useEffect(() => {
    const savedReplacement = Boolean(previousValue.current) && !value;
    previousValue.current = value;
    if (savedReplacement) {
      setRevealedValue(null);
      setVisible(false);
      setRevealError(null);
    }
  }, [value]);

  useEffect(() => {
    setRevealedValue(null);
    setVisible(false);
    setRevealError(null);
  }, [savedPreview]);

  const displayValue = value
    ? value
    : showingSaved
      ? visible
        ? revealedValue ?? savedPreview!
        : SAVED_MASK
      : "";

  const handleChange = (next: string) => {
    if (readOnly) return;
    if (!showingSaved) {
      onChange(next);
      return;
    }
    // Editing replaces the stand-in; strip leftover mask bullets if the browser appended.
    const cleaned = next.replace(/•/g, "");
    if (cleaned === (revealedValue ?? savedPreview)) {
      onChange("");
      return;
    }
    onChange(cleaned);
  };

  return (
    <div className="secret-field">
      <label className="field-label" htmlFor={inputId}>
        {label}
        {hint ? <span className="secret-field-hint"> {hint}</span> : null}
      </label>
      <div className="secret-field-row">
        <input
          ref={inputRef}
          id={inputId}
          className="field-input"
          type={visible ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          readOnly={readOnly}
          value={displayValue}
          onFocus={() => {
            if (showingSaved && !readOnly) {
              // Select stand-in so the next keystroke replaces it.
              requestAnimationFrame(() => inputRef.current?.select());
            }
          }}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={showingSaved || readOnly ? undefined : placeholder}
        />
        <button
          type="button"
          className="secret-field-toggle"
          onClick={async () => {
            if (visible) {
              setVisible(false);
              return;
            }
            if (showingSaved && onReveal && revealedValue === null) {
              setRevealing(true);
              setRevealError(null);
              try {
                setRevealedValue(await onReveal());
              } catch (error) {
                setRevealError(error instanceof Error ? error.message : "Could not reveal the saved secret.");
                return;
              } finally {
                setRevealing(false);
              }
            }
            setVisible(true);
          }}
          disabled={revealing}
          aria-pressed={visible}
          aria-label={visible ? "Hide secret" : "Show secret"}
          title={visible ? "Hide" : "Show"}
        >
          {revealing ? "Loading…" : visible ? "Hide" : "Show"}
        </button>
      </div>
      {revealError ? (
        <p className="settings-hint" role="alert">
          {revealError}
        </p>
      ) : null}
    </div>
  );
}
