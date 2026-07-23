// Stub types for @earendil-works/pi-coding-agent
// Types are intentionally loose (any) — gate check only targets syntax errors & duplicate declarations.

/* eslint-disable */
declare module "@earendil-works/pi-coding-agent" {
  export const SessionManager: any;
  export const CustomEditor: any;
  export const ReadonlyFooterDataProvider: any;
  export const ToolExecutionComponent: any;
  export const AssistantMessageComponent: any;
  export function estimateTokens(...args: any[]): any;
  export function copyToClipboard(...args: any[]): any;
  export function createBashToolDefinition(...args: any[]): any;
  export function createEditToolDefinition(...args: any[]): any;
  export function createFindToolDefinition(...args: any[]): any;
  export function createGrepToolDefinition(...args: any[]): any;
  export function createLsToolDefinition(...args: any[]): any;
  export function createReadToolDefinition(...args: any[]): any;
  export function createWriteToolDefinition(...args: any[]): any;
  export function generateDiffString(...args: any[]): any;
  export function getSettingsListTheme(...args: any[]): any;
  export function initTheme(...args: any[]): any;
  export function renderDiff(...args: any[]): any;
  export function keyHint(...args: any[]): any;

  // Catch-all for anything else
  export type ExtensionAPI = any;
  export type ExtensionContext = any;
  export type ExtensionCommandContext = any;
  export type SessionInfo = any;
  export type Theme = any;
  export type ThemeColor = any;
}

declare module "@earendil-works/pi-coding-agent/dist/core/keybindings.js" {
  export type KeybindingsManager = any;
}
