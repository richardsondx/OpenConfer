import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "./primitives";
import { DEMO_USE_CASES, type DemoUseCase } from "../lib/settings";

const MENU_WIDTH = 304;
const MENU_GAP = 8;
const VIEWPORT_GUTTER = 16;

type MenuPosition = {
  bottom?: number;
  left: number;
  maxHeight: number;
  top?: number;
  width: number;
};

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
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const [useCase, setUseCase] = useState<DemoUseCase>("decision");

  const positionMenu = useCallback(() => {
    const trigger = rootRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const triggerRect = trigger.getBoundingClientRect();
    const width = Math.min(MENU_WIDTH, window.innerWidth - VIEWPORT_GUTTER * 2);
    const left = Math.min(
      Math.max(triggerRect.right - width, VIEWPORT_GUTTER),
      window.innerWidth - width - VIEWPORT_GUTTER,
    );
    const availableBelow = window.innerHeight - triggerRect.bottom - MENU_GAP - VIEWPORT_GUTTER;
    const availableAbove = triggerRect.top - MENU_GAP - VIEWPORT_GUTTER;
    const openAbove = menu.scrollHeight > availableBelow && availableAbove > availableBelow;

    setMenuPosition({
      ...(openAbove
        ? { bottom: window.innerHeight - triggerRect.top + MENU_GAP }
        : { top: triggerRect.bottom + MENU_GAP }),
      left,
      maxHeight: Math.max(openAbove ? availableAbove : availableBelow, 0),
      width,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }

    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [open, positionMenu]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
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

      {open &&
        createPortal(
          <div
            id={menuId}
            ref={menuRef}
            className="test-call-picker-menu"
            role="menu"
            style={{
              ...menuPosition,
              visibility: menuPosition ? "visible" : "hidden",
            }}
          >
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
          </div>,
          document.body,
        )}
    </div>
  );
}
