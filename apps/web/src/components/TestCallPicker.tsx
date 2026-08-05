import { useEffect, useId, useRef, useState } from "react";
import { Button } from "./primitives";
import { DEMO_USE_CASES, type DemoUseCase } from "../lib/settings";

export function TestCallPicker({
  id,
  busy = false,
  voiceReady,
  onStartTestCall,
  buttonVariant = "primary",
  buttonLabel = "Start test call",
}: {
  id?: string;
  busy?: boolean;
  voiceReady: boolean;
  onStartTestCall: (useCase: DemoUseCase) => void;
  buttonVariant?: "primary" | "secondary";
  buttonLabel?: string;
}) {
  const generatedId = useId();
  const menuId = id ?? `test-call-menu-${generatedId}`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [useCase, setUseCase] = useState<DemoUseCase>("decision");

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const start = (nextUseCase: DemoUseCase) => {
    setUseCase(nextUseCase);
    setOpen(false);
    onStartTestCall(nextUseCase);
  };

  return (
    <div className="test-call-picker" ref={rootRef}>
      <Button
        type="button"
        variant={buttonVariant}
        className="test-call-picker-main"
        disabled={busy || !voiceReady}
        onClick={() => start(useCase)}
      >
        {busy ? "Starting…" : buttonLabel}
      </Button>
      <Button
        type="button"
        variant={buttonVariant}
        className="test-call-picker-toggle"
        aria-label="Choose test call scenario"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={busy || !voiceReady}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true" className="test-call-picker-chevron" />
      </Button>

      {open && (
        <div id={menuId} className="test-call-picker-menu" role="menu">
          <div className="test-call-picker-menu-heading">Choose a scenario</div>
          {DEMO_USE_CASES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`test-call-picker-option${item.id === useCase ? " is-selected" : ""}`}
              onClick={() => start(item.id)}
            >
              <span className="test-call-picker-option-label">{item.label}</span>
              <span className="test-call-picker-option-description">{item.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
