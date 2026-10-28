"use client"
import { CommandPalette, type CommandPaletteProps } from "./command-palette"
export type CommandProps = Omit<
  CommandPaletteProps,
  "presentation" | "open" | "defaultOpen" | "onOpenChange" | "finalFocus"
>
/** Inline adapter retaining the palette's keyboard, IME and caller-result contract. */
export function Command(props: CommandProps) {
  return <CommandPalette {...props} presentation="inline" />
}
