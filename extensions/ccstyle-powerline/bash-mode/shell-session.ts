import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { BashTranscriptStore } from "./transcript.ts";
import type { ShellSessionState } from "./types.ts";

const READY_SENTINEL = "__PI_READY__";
const COMMAND_START_SENTINEL = "__PI_CMD_START__";
const COMMAND_DONE_SENTINEL = "__PI_CMD_DONE__";

function stripAnsi(value: string): string {
  return value
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\u0007]*(?:\u0007|\x1b\\)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getCloseExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === "number") {
    return code;
  }

  if (signal === "SIGINT") {
    return 130;
  }

  if (signal === "SIGTERM") {
    return 143;
  }

  if (signal === "SIGKILL") {
    return 137;
  }

  return 1;
}

function getShellInitScript(shellName: string): string {
  if (shellName.includes("fish")) {
    return `
function __pi_eval
  set -l __pi_id $argv[1]
  set -l __pi_file $argv[2]
  echo "${COMMAND_START_SENTINEL}:$__pi_id:$PWD"
  source $__pi_file
  set -l __pi_status $status
  rm -f $__pi_file
  echo "${COMMAND_DONE_SENTINEL}:$__pi_id:$__pi_status:$PWD"
end
echo "${READY_SENTINEL}:$PWD"
`;
  }

  if (shellName.includes("bash")) {
    return `
__pi_eval() {
  local __pi_id="$1"
  local __pi_file="$2"
  printf '%s:%s:%s\n' '${COMMAND_START_SENTINEL}' "$__pi_id" "$PWD"
  source "$__pi_file"
  local __pi_status=$?
  rm -f "$__pi_file"
  printf '%s:%s:%s:%s\n' '${COMMAND_DONE_SENTINEL}' "$__pi_id" "$__pi_status" "$PWD"
}
printf '%s:%s\n' '${READY_SENTINEL}' "$PWD"
`;
  }

  return `
function __pi_eval() {
  local __pi_id="$1"
  local __pi_file="$2"
  print -r -- "${COMMAND_START_SENTINEL}:$__pi_id:$PWD"
  builtin source "$__pi_file"
  local __pi_status=$?
  rm -f "$__pi_file"
  print -r -- "${COMMAND_DONE_SENTINEL}:$__pi_id:$__pi_status:$PWD"
}
print -r -- "${READY_SENTINEL}:$PWD"
`;
}

export class ManagedShellSession {
  private readonly shellPath: string;
  private readonly transcript: BashTranscriptStore;
  private readonly onStateChange: () => void;
  private readonly onCommandSuccess: (command: string, cwd: string) => void;
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly tempDir = mkdtempSync(join(tmpdir(), "powerline-bash-mode-"));
  private buffer = "";
  private commandCounter = 0;
  private currentCommandId: string | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private disposed = false;
  readonly state: ShellSessionState;

  constructor(
    shellPath: string,
    cwd: string,
    transcript: BashTranscriptStore,
    onStateChange: () => void,
    onCommandSuccess: (command: string, cwd: string) => void,
  ) {
    this.shellPath = shellPath;
    this.transcript = transcript;
    this.onStateChange = onStateChange;
    this.onCommandSuccess = onCommandSuccess;
    const shellName = basename(shellPath).toLowerCase();
    this.state = {
      ready: false,
      running: false,
      shellPath,
      shellName,
      cwd,
      lastExitCode: null,
    };
  }

  async ensureReady(): Promise<void> {
    if (this.state.ready) return;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.process = spawn(this.shellPath, [], {
      cwd: this.state.cwd,
      env: {
        ...process.env,
        DISABLE_AUTO_UPDATE: "true",
        DISABLE_UPDATE_PROMPT: "true",
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.handleChunk(String(chunk)));
    this.process.stderr.on("data", (chunk) => this.handleChunk(String(chunk)));
    this.process.on("error", (error) => {
      if (!this.state.ready) {
        this.readyReject?.(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.process.on("close", (code, signal) => {
      const exitCode = getCloseExitCode(code, signal);
      if (!this.disposed && !this.state.ready) {
        this.readyReject?.(new Error(`Shell failed to start (exit ${exitCode})`));
      }

      if (this.currentCommandId) {
        this.transcript.finishCommand(this.currentCommandId, exitCode);
        this.state.lastExitCode = exitCode;
        this.currentCommandId = null;
      }

      this.process = null;
      this.buffer = "";
      this.readyPromise = null;
      this.readyResolve = null;
      this.readyReject = null;
      this.state.ready = false;
      this.state.running = false;
      this.onStateChange();
    });

    this.sendRaw(getShellInitScript(this.state.shellName) + "\n");
    return this.readyPromise;
  }

  async runCommand(command: string): Promise<void> {
    await this.ensureReady();
    if (!this.process) {
      throw new Error("Shell process not available");
    }
    if (this.state.running) {
      throw new Error("Shell command already running");
    }

    const id = `cmd-${++this.commandCounter}`;
    const extension = this.state.shellName.includes("fish") ? "fish" : "sh";
    const filePath = join(this.tempDir, `${id}.${extension}`);
    writeFileSync(filePath, command.endsWith("\n") ? command : `${command}\n`, "utf8");

    this.currentCommandId = id;
    this.state.running = true;
    this.transcript.startCommand(id, command, this.state.cwd);
    this.onStateChange();
    this.sendRaw(`__pi_eval ${quoteShellArg(id)} ${quoteShellArg(filePath)}\n`);
  }

  interrupt(): void {
    if (!this.process || !this.state.running) return;
    try {
      process.kill(-this.process.pid!, "SIGINT");
    } catch {
      // The shell may not own a process group anymore.
      this.process.kill("SIGINT");
    }
  }

  dispose(): void {
    this.disposed = true;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    if (!this.process) return;
    try {
      process.kill(-this.process.pid!, "SIGKILL");
    } catch {
      // The shell may not own a process group anymore.
      this.process.kill("SIGKILL");
    }
    this.process = null;
  }

  private sendRaw(text: string): void {
    if (!this.process) return;
    this.process.stdin.write(text);
  }

  private handleChunk(chunk: string): void {
    const sanitized = stripAnsi(chunk).replace(/\r/g, "");
    if (!sanitized) return;

    this.buffer += sanitized;
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";

    for (const rawLine of parts) {
      const line = rawLine.trimEnd();
      if (!this.state.ready) {
        if (line.startsWith(`${READY_SENTINEL}:`)) {
          this.state.ready = true;
          this.state.cwd = line.slice(READY_SENTINEL.length + 1) || this.state.cwd;
          this.readyResolve?.();
          this.readyResolve = null;
          this.readyReject = null;
          this.onStateChange();
        }
        continue;
      }

      if (line.startsWith(`${COMMAND_START_SENTINEL}:`)) {
        const [, id, cwd] = line.split(":");
        if (cwd) this.state.cwd = cwd;
        this.currentCommandId = id ?? this.currentCommandId;
        this.onStateChange();
        continue;
      }

      if (line.startsWith(`${COMMAND_DONE_SENTINEL}:`)) {
        const [, id, exitCodeText, cwd] = line.split(":");
        const exitCode = Number.parseInt(exitCodeText ?? "1", 10);
        this.state.running = false;
        this.state.lastExitCode = Number.isFinite(exitCode) ? exitCode : 1;
        if (cwd) this.state.cwd = cwd;
        if (id) {
          this.transcript.finishCommand(id, this.state.lastExitCode);
          const snapshot = this.transcript.getSnapshot();
          const command = snapshot.commands.find((entry) => entry.id === id);
          if (command && this.state.lastExitCode === 0) {
            this.onCommandSuccess(command.command, this.state.cwd);
          }
        }
        this.currentCommandId = null;
        this.onStateChange();
        continue;
      }

      if (!this.currentCommandId) continue;
      this.transcript.appendOutput(this.currentCommandId, line);
      this.onStateChange();
    }
  }
}
