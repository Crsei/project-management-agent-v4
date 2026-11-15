// Adapted from t3code 7379f1969b0f4b579327cf81299ef8cc3ddf8e9c contextChipParts.tsx.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { BookOpenIcon, CircleDashedIcon, FileIcon, FileSpreadsheetIcon, FileTextIcon, FileTypeIcon, FilmIcon, ImageIcon, PresentationIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@agent/components/ui/tooltip";
import { ContextChip, ContextChipLabel, type ContextChipKind } from "./context-chip";
import { CONTEXT_CHIP_ACCENTS } from "./context-chip-accents";

export const contextChipTheme = {
  ...Object.fromEntries(Object.entries(CONTEXT_CHIP_ACCENTS).map(([kind, color]) => [`--context-chip-${kind}`, `oklch(from ${color} var(--context-chip-lightness, 0.62) c h)`])),
  "--context-chip-invalid": "var(--destructive)", "--color-message": "var(--secondary)", "--color-message-foreground": "var(--foreground)",
} as CSSProperties;

// Native document categories; reuse host Lucide glyphs instead of importing a second sprite runtime.
const documentKinds: Record<string, ContextChipKind> = { pdf: "doc-pdf", doc: "doc-word", docx: "doc-word", odt: "doc-word", rtf: "doc-word", xls: "doc-spreadsheet", xlsx: "doc-spreadsheet", ods: "doc-spreadsheet", csv: "doc-spreadsheet", tsv: "doc-spreadsheet", ppt: "doc-slides", pptx: "doc-slides", odp: "doc-slides", epub: "doc-epub" };
const documentIcons = { "doc-pdf": FileTypeIcon, "doc-word": FileTextIcon, "doc-spreadsheet": FileSpreadsheetIcon, "doc-slides": PresentationIcon, "doc-epub": BookOpenIcon };

function middleTruncateAttachmentName(name: string, maxCharacters = 36): string {
  const characters = Array.from(name);
  if (characters.length <= maxCharacters) return name;
  if (maxCharacters <= 0) return "";
  if (maxCharacters === 1) return "…";
  const available = maxCharacters - 1;
  const suffixLength = Math.min(available - 1, available >= 18 ? 14 : Math.ceil(available / 2));
  const prefixLength = available - suffixLength;
  const suffix = suffixLength === 0 ? "" : characters.slice(-suffixLength).join("");
  return `${characters.slice(0, prefixLength).join("")}…${suffix}`;
}
export function SkillContextIcon() {
  return <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></svg>;
}

export function ContextChipShell({ icon, label, tooltip, ...props }: Omit<ComponentProps<typeof ContextChip>, "className" | "render"> & { icon: ReactNode; label: string; tooltip?: ReactNode }) {
  const chip = <ContextChip data-context-unresolved={props.state === "unresolved" ? "true" : undefined} tabIndex={tooltip ? 0 : undefined} {...props}>{icon}<ContextChipLabel>{label}</ContextChipLabel></ContextChip>;
  if (!tooltip) return chip;
  return <TooltipProvider><Tooltip><TooltipTrigger render={chip} /><TooltipContent side="top" className="whitespace-pre-wrap">{tooltip}</TooltipContent></Tooltip></TooltipProvider>;
}

export function ContextChipPopover(props: { kind: ContextChipKind; icon: ReactNode; label: string; copyMarkdown?: string; accessibleLabel: string; accent?: string; children: ReactNode; state?: "unresolved" | "invalid" }) {
  return <Popover><PopoverTrigger render={<ContextChip kind={props.kind} state={props.state} style={props.accent ? { "--context-chip-accent": props.accent } as CSSProperties : undefined} render={<button type="button" />} aria-label={`${props.accessibleLabel}. Show details`} data-markdown-copy={props.copyMarkdown} />}>
    {props.icon}<ContextChipLabel>{props.label}</ContextChipLabel>
  </PopoverTrigger><PopoverContent side="top" className="w-[min(32rem,90vw)] max-h-[70vh] overflow-auto p-2" style={contextChipTheme}><PopoverTitle className="sr-only">{props.accessibleLabel}</PopoverTitle>{props.children}</PopoverContent></Popover>;
}

export function ImageChipButton({ name, previewUrl, size, suffix, disabled, ...props }: Omit<ComponentProps<typeof ContextChip>, "kind" | "render"> & { name: string; previewUrl?: string; size: string; suffix?: string; disabled?: boolean }) {
  return <ContextChip kind="image" render={<button type="button" disabled={disabled} />} aria-label={`Image attachment, ${name}, ${size}`} {...props}>
    {previewUrl ? <img src={previewUrl} alt="" className="size-[1em] shrink-0 self-center rounded-sm object-cover" /> : <ImageIcon />}
    <ContextChipLabel className="flex items-baseline gap-[0.33em]"><span className="min-w-0 max-w-72 overflow-x-clip text-ellipsis whitespace-nowrap">{middleTruncateAttachmentName(name)}</span><span className="shrink-0 text-[10px] text-current">{size}</span>{suffix ? <span className="text-[10px] text-current">{suffix}</span> : null}</ContextChipLabel>
  </ContextChip>;
}

export function FileChip({ name, size, suffix, error, onOpen }: { name: string; size: string; suffix?: string; error?: boolean; onOpen?: () => void }) {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const kind = documentKinds[extension] ?? (["avi", "m4v", "mkv", "mov", "mp4", "ogv", "webm"].includes(extension) ? "video" : "file");
  const Icon = kind === "video" ? FilmIcon : documentIcons[kind as keyof typeof documentIcons] ?? FileIcon;
  return <ContextChip kind={kind} state={error ? "invalid" : undefined} render={onOpen ? <button type="button" onClick={onOpen} /> : undefined} title={[name, size, suffix].filter(Boolean).join(" · ")}><Icon /><ContextChipLabel className="flex items-baseline gap-[0.33em]"><span className="min-w-0 max-w-72 overflow-x-clip text-ellipsis whitespace-nowrap">{middleTruncateAttachmentName(name)}</span><span className="shrink-0 text-[10px]">{size}</span>{suffix ? <span className="text-[10px]">{suffix}</span> : null}</ContextChipLabel></ContextChip>;
}

export function UnresolvedChip({ label, tooltip, copyMarkdown }: { label: string; tooltip: string; copyMarkdown?: string }) {
  return <ContextChipShell kind="neutral" state="unresolved" icon={<CircleDashedIcon />} label={label} tooltip={tooltip} aria-label={`Unavailable context, ${label}`} data-markdown-copy={copyMarkdown} />;
}
