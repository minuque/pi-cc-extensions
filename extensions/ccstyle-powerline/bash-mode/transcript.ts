import type { BashCommandRecord, BashModeSettings, BashTranscriptSnapshot } from "./types.ts";

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function compactLines(lines: string[]): string[] {
  const normalized: string[] = [];
  for (const line of lines) {
    const sanitized = line.replace(/\r/g, "");
    if (sanitized.length === 0) {
      normalized.push("");
      continue;
    }
    normalized.push(...sanitized.split("\n"));
  }
  return normalized;
}

export class BashTranscriptStore {
  private readonly settings: Pick<BashModeSettings, "transcriptMaxLines" | "transcriptMaxBytes">;
  private commands: BashCommandRecord[] = [];
  private commandIndex = new Map<string, BashCommandRecord>();
  private totalLines = 0;
  private totalBytes = 0;
  private truncatedCommands = 0;

  constructor(settings: Pick<BashModeSettings, "transcriptMaxLines" | "transcriptMaxBytes">) {
    this.settings = settings;
  }

  startCommand(id: string, command: string, cwdAtStart: string): BashCommandRecord {
    const entry: BashCommandRecord = {
      id,
      command,
      cwdAtStart,
      startedAt: Date.now(),
      output: [],
      outputBytes: 0,
      exitCode: null,
      finishedAt: null,
      truncated: false,
    };

    this.commands.push(entry);
    this.commandIndex.set(id, entry);
    this.enforceLimits();
    return entry;
  }

  appendOutput(id: string, chunk: string): void {
    const entry = this.commandIndex.get(id);
    if (!entry || !chunk) return;

    const lines = compactLines([chunk]);
    if (lines.length === 0) return;

    entry.output.push(...lines);
    const addedBytes = lines.reduce((sum, line) => sum + byteLength(line) + 1, 0);
    entry.outputBytes += addedBytes;
    this.totalLines += lines.length;
    this.totalBytes += addedBytes;
    this.enforceLimits();
  }

  finishCommand(id: string, exitCode: number): void {
    const entry = this.commandIndex.get(id);
    if (!entry) return;

    entry.exitCode = exitCode;
    entry.finishedAt = Date.now();
  }

  clear(): void {
    this.commands = [];
    this.commandIndex.clear();
    this.totalLines = 0;
    this.totalBytes = 0;
    this.truncatedCommands = 0;
  }

  getSnapshot(): BashTranscriptSnapshot {
    return {
      commands: this.commands.map((command) => ({
        ...command,
        output: [...command.output],
      })),
      totalLines: this.totalLines,
      totalBytes: this.totalBytes,
      truncatedCommands: this.truncatedCommands,
    };
  }

  private enforceLimits(): void {
    while (
      this.commands.length > 1
      && (this.totalLines > this.settings.transcriptMaxLines || this.totalBytes > this.settings.transcriptMaxBytes)
    ) {
      const removed = this.commands.shift();
      if (!removed) break;
      this.commandIndex.delete(removed.id);
      this.totalLines = Math.max(0, this.totalLines - removed.output.length);
      this.totalBytes = Math.max(0, this.totalBytes - removed.outputBytes);
      this.truncatedCommands += 1;
      removed.truncated = true;
    }
  }
}
