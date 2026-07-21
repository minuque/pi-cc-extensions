// Stub types for @earendil-works/pi-tui
// Types are intentionally loose (any) — gate check only targets syntax errors & duplicate declarations.

/* eslint-disable */
declare module "@earendil-works/pi-tui" {
  export const Text: any;
  export const Component: any;
  export const SelectList: any;
  export const Key: any;
  export const TUI_KEYBINDINGS: any;
  export function matchesKey(...args: any[]): any;
  export function isKeyRelease(...args: any[]): any;
  export function truncateToWidth(...args: any[]): any;
  export function visibleWidth(...args: any[]): any;
  export function wrapTextWithAnsi(...args: any[]): any;
  export function deleteAllKittyImages(...args: any[]): any;
  export function fuzzyFilter(...args: any[]): any;

  export type AutocompleteItem = any;
  export type AutocompleteProvider = any;
  export type AutocompleteSuggestions = any;
  export type SelectItem = any;
}
