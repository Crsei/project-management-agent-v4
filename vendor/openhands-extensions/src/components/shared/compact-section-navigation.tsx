import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useLocation } from "react-router-dom";

interface CompactSectionNavigationProps {
  label: string;
  currentLabel?: string;
  testId: string;
  children: ReactNode;
}

function SectionDisclosure({ label, currentLabel, testId, children }: CompactSectionNavigationProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef(false);
  useEffect(() => {
    if (!isOpen) return;
    if (focusOnOpen.current) {
      containerRef.current?.querySelector<HTMLAnchorElement>("a[href]")?.focus();
      focusOnOpen.current = false;
    }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setIsOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setIsOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [isOpen]);
  return <div ref={containerRef} className="oh-compact-navigation" data-testid={testId} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setIsOpen(false);
  }}>
    <button ref={triggerRef} type="button" aria-label={`${label}${currentLabel ? `: ${currentLabel}` : ""}`} aria-expanded={isOpen} aria-controls={menuId} onClick={() => setIsOpen(!isOpen)} onKeyDown={event => {
      if (event.key !== "ArrowDown") return;
      event.preventDefault();
      if (isOpen) containerRef.current?.querySelector<HTMLAnchorElement>("a[href]")?.focus();
      else { focusOnOpen.current = true; setIsOpen(true); }
    }} className="oh-compact-trigger">
      <span className="oh-nav-caption">{label}</span>{currentLabel && <span className="oh-compact-current">{currentLabel}</span>}<ChevronDown size={16} aria-hidden />
    </button>
    {isOpen && <nav id={menuId} aria-label={label} className="oh-compact-menu" onClick={event => {
      if (event.target instanceof Element && event.target.closest("a")) setIsOpen(false);
    }}>{children}</nav>}
  </div>;
}

/** The existing host router owns navigation; route changes dismiss this disclosure. */
export function CompactSectionNavigation(props: CompactSectionNavigationProps) {
  const location = useLocation();
  return <SectionDisclosure key={`${location.pathname}${location.search}`} {...props} />;
}
