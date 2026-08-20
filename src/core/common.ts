import { statSync, type WriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname, isAbsolute, join, win32 } from 'node:path';
import { DEFAULT_MAX_BYTES } from '@earendil-works/pi-coding-agent';
import type { BackgroundTaskChildProcess } from './registry.js';

export const TASK_STATUS_VALUES = ['running', 'completed', 'failed', 'killed'] as const;
export const TERMINAL_TASK_STATUS_VALUES = ['completed', 'failed', 'killed'] as const;

export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];
export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUS_VALUES)[number];
export type KillKind = 'user' | 'timeout' | 'output_cap' | 'shutdown';

export type JsonObject = Readonly<Record<PropertyKey, unknown>>;

export interface BgTaskSnapshot {
  id: string;
  name?: string | undefined;
  command: string;
  description?: string | undefined;
  status: TaskStatus;
  outputPath: string;
  cwd: string;
  startTime: number;
  endTime?: number | undefined;
  exitCode?: number | null | undefined;
  signal?: string | null | undefined;
  pid?: number | undefined;
  bytesWritten: number;
  error?: string | undefined;
  notified: boolean;
  notifyOnCompletion: boolean;
  triggerOnCompletion: boolean;
  timeoutSeconds?: number | undefined;
}

export interface BgTask extends Omit<BgTaskSnapshot, 'name'> {
  name: string;
  outputAbsPath: string;
  metadataAbsPath: string;
  child?: BackgroundTaskChildProcess | undefined;
  stream?: WriteStream | undefined;
  timeoutHandle?: NodeJS.Timeout | undefined;
  killKind?: KillKind | undefined;
  killSignalSent?: boolean | undefined;
  killEscalationTimer?: NodeJS.Timeout | undefined;
  capExceeded?: boolean | undefined;
  finalized?: boolean | undefined;
  terminalPublished?: boolean | undefined;
  terminalPublishInFlight?: boolean | undefined;
  terminalPublishRetryHandle?: NodeJS.Timeout | undefined;
  /** Optional protocol barrier used by EventBus run requests so early child exits cannot publish before the run response is observable. */
  terminalPublicationGate?: Promise<void> | undefined;
  metadataWriteChain?: Promise<void> | undefined;
  waiters: Array<() => void>;
}

export type CompletionDeliveryMode =
  | 'notification-and-wake'
  | 'notification-only'
  | 'manual-monitoring';

export interface CompletionDeliveryGuidance {
  readonly mode: CompletionDeliveryMode;
  readonly notificationEnabled: boolean;
  readonly automaticWakeEnabled: boolean;
  readonly text: string;
}

/**
 * Describe the actual parent-agent completion path for one bg_run launch.
 * A wake request cannot take effect without the notification that carries it.
 */
export function deriveCompletionDeliveryGuidance(
  notifyOnCompletion: boolean,
  triggerOnCompletion: boolean,
): CompletionDeliveryGuidance {
  if (notifyOnCompletion && triggerOnCompletion) {
    return {
      mode: 'notification-and-wake',
      notificationEnabled: true,
      automaticWakeEnabled: true,
      text: [
        'Terminal notification: enabled.',
        'Steering delivery: enabled at the next model-call boundary while the agent is active.',
        'Automatic idle wake-up: enabled.',
        'Next action: do not poll or sleep merely to wait; continue only independent useful work, otherwise end this turn and wait for <background-task-notification>.',
      ].join('\n'),
    };
  }

  if (notifyOnCompletion) {
    return {
      mode: 'notification-only',
      notificationEnabled: true,
      automaticWakeEnabled: false,
      text: [
        'Terminal notification: enabled.',
        'Steering delivery: enabled at the next model-call boundary while the agent is active.',
        'Automatic idle wake-up: disabled. The terminal notification will not start an agent turn while Pi is idle.',
        'Next action: automatic wake-up was explicitly disabled; use bg_status/bg_logs only when deliberate monitoring is required, without tight polling.',
      ].join('\n'),
    };
  }

  return {
    mode: 'manual-monitoring',
    notificationEnabled: false,
    automaticWakeEnabled: false,
    text: [
      'Terminal notification: disabled.',
      'Steering delivery: disabled.',
      triggerOnCompletion
        ? 'Automatic idle wake-up: disabled because terminal notifications are disabled. triggerOnCompletion has no effect while notifyOnCompletion is false.'
        : 'Automatic idle wake-up: disabled.',
      'Next action: completion delivery was explicitly disabled; use bg_status/bg_logs only for deliberate manual monitoring, without tight polling.',
    ].join('\n'),
  };
}

export interface BgRunDetails {
  task: BgTaskSnapshot;
}

export interface BgStatusDetails {
  tasks: BgTaskSnapshot[];
}

export interface BgLogsDetails {
  task: BgTaskSnapshot;
  path: string;
  bytesRead: number;
  truncated: boolean;
  tail: boolean;
}

export interface BgKillDetails {
  task: BgTaskSnapshot;
  message: string;
}

export interface StartTaskOptions {
  name?: string | undefined;
  description?: string | undefined;
  timeoutSeconds?: number | undefined;
  notifyOnCompletion?: boolean | undefined;
  triggerOnCompletion?: boolean | undefined;
  /** @internal EventBus protocol barrier; callers should not set this outside the extension service. */
  terminalPublicationGate?: Promise<void> | undefined;
}

export const DEFAULT_LOG_BYTES = Math.min(DEFAULT_MAX_BYTES, 50 * 1024);
export const MAX_LOG_BYTES = Math.min(DEFAULT_MAX_BYTES, 50 * 1024);
export const COMMAND_PREVIEW_CHARS = 90;
const parseJsonValue: (text: string) => unknown = globalThis.JSON.parse;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}

export function parseJsonText(text: string): unknown {
  return parseJsonValue(text);
}

export function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'session';
}

export function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function normalizeTaskName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = compactWhitespace(stripMatchingQuotes(value));
  if (!normalized) return undefined;
  return truncateChars(normalized, 80);
}

export function deriveTaskNameFromCommand(command: string): string {
  const normalized = compactWhitespace(stripMatchingQuotes(command));
  if (!normalized) return 'Background task';

  const packageScript = /^(npm|pnpm|yarn|bun)\s+(?:(run)\s+)?([^\s;&|]+)/.exec(normalized);
  if (packageScript) {
    const runner = packageScript[1] ?? 'npm';
    const run = packageScript[2] !== undefined ? ' run' : '';
    const script = packageScript[3] ?? '';
    return truncateChars(`${runner}${run} ${script}`, 48);
  }

  const words = normalized.split(/\s+/).slice(0, 5).join(' ');
  return truncateChars(words.length > 0 ? words : normalized, 48);
}

export function taskDisplayName(task: {
  name?: string | undefined;
  description?: string | undefined;
  command?: string | undefined;
  id?: string | undefined;
}): string {
  const commandName =
    task.command && task.command.length > 0 ? deriveTaskNameFromCommand(task.command) : undefined;
  return (
    normalizeTaskName(task.name) ??
    normalizeTaskName(task.description) ??
    commandName ??
    task.id ??
    'Background task'
  );
}

function parseNameValueAndRest(valueAndRest: string): { value: string; rest: string } | undefined {
  const input = valueAndRest.trimStart();
  if (!input) return undefined;
  const quote = input[0];
  if (quote === '"' || quote === "'") {
    let escaped = false;
    let value = '';
    for (let i = 1; i < input.length; i++) {
      const char = input.charAt(i);
      if (escaped) {
        value += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        return { value, rest: input.slice(i + 1).trimStart() };
      }
      value += char;
    }
    return undefined;
  }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input);
  if (!match) return undefined;
  const parsedValue = match[1];
  if (parsedValue === undefined) return undefined;
  return { value: parsedValue, rest: match[2]?.trimStart() ?? '' };
}

export function parseBgCommandArgs(args: string): {
  name?: string;
  command: string;
} {
  let input = args.trim();
  let name: string | undefined;

  while (input) {
    let consumed = false;
    for (const prefix of ['--name=', '-n=']) {
      if (input.startsWith(prefix)) {
        const parsed = parseNameValueAndRest(input.slice(prefix.length));
        if (!parsed) throw new Error(`${prefix.slice(0, -1)} requires a task name`);
        name = normalizeTaskName(parsed.value);
        input = parsed.rest;
        consumed = true;
        break;
      }
    }
    if (consumed) continue;

    for (const prefix of ['--name', '-n']) {
      if (input === prefix || input.startsWith(`${prefix} `) || input.startsWith(`${prefix}\t`)) {
        const parsed = parseNameValueAndRest(input.slice(prefix.length));
        if (!parsed) throw new Error(`${prefix} requires a task name`);
        name = normalizeTaskName(parsed.value);
        input = parsed.rest;
        consumed = true;
        break;
      }
    }
    if (consumed) continue;

    if (input === '--') {
      input = '';
      break;
    }
    if (input.startsWith('-- ')) {
      input = input.slice(3).trimStart();
      break;
    }
    break;
  }

  return name ? { name, command: input } : { command: input };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return `${String(minutes)}m${remSeconds > 0 ? `${String(remSeconds)}s` : ''}`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${String(hours)}h${remMinutes > 0 ? `${String(remMinutes)}m` : ''}`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export type ShellDialect = 'cmd' | 'posix';

export interface ShellInvocation {
  shell: string;
  args: string[];
  dialect: ShellDialect;
  windowsVerbatimArguments: boolean;
  stdinCommand?: string | undefined;
}

/** Pi's resolved shell configuration for a task session. */
export interface PiShellConfig {
  shell: string;
  args: string[];
  commandTransport?: 'argv' | 'stdin' | undefined;
}

export class ShellInvocationError extends Error {
  readonly code = 'pi_bg_shell_invalid';

  constructor(message: string) {
    super(`pi_bg_shell_invalid: ${message}`);
    this.name = 'ShellInvocationError';
  }
}

type ShellCandidateResult =
  | { readonly found: true }
  | { readonly found: false; readonly diagnostic: string };

function failShellInvocation(message: string): never {
  throw new ShellInvocationError(message);
}

function shellErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWindowsExecutablePath(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return extension === '.exe' || extension === '.com';
}

function validateWindowsShellPath(path: string, label: string): string {
  if (path.length === 0) failShellInvocation(`${label} is empty`);
  if (!isAbsolute(path) && !win32.isAbsolute(path)) {
    failShellInvocation(`${label} must be an absolute path`);
  }
  if (!isWindowsExecutablePath(path)) {
    failShellInvocation(`${label} must point to a .exe or .com file`);
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch (error) {
    failShellInvocation(`${label} stat failed: ${shellErrorMessage(error)}`);
  }
  if (!stats.isFile()) failShellInvocation(`${label} must point to a regular file`);
  return path;
}

function inspectWindowsShellCandidate(path: string): ShellCandidateResult {
  if (!isWindowsExecutablePath(path)) {
    return { found: false, diagnostic: `${path} is not a .exe or .com path` };
  }
  try {
    const stats = statSync(path);
    if (stats.isFile()) return { found: true };
    return { found: false, diagnostic: `${path} is not a regular file` };
  } catch (error) {
    return { found: false, diagnostic: `${path}: ${shellErrorMessage(error)}` };
  }
}

function windowsPathValue(env: NodeJS.ProcessEnv): string {
  return env['PATH'] ?? env['Path'] ?? env['path'] ?? '';
}

function resolveWindowsBash(env: NodeJS.ProcessEnv): string {
  const pathValue = windowsPathValue(env);
  const diagnostics: string[] = [];
  for (const dir of pathValue.split(';').filter((entry) => entry.length > 0)) {
    for (const name of ['bash.exe', 'bash.com']) {
      const candidate = join(dir, name);
      const result = inspectWindowsShellCandidate(candidate);
      if (result.found) return candidate;
      diagnostics.push(result.diagnostic);
    }
  }
  const suffix = diagnostics.length > 0 ? `: ${diagnostics.join('; ')}` : '';
  failShellInvocation(`PI_BG_SHELL=bash could not resolve bash.exe or bash.com on PATH${suffix}`);
}

function cmdShellInvocation(command: string, shell: string): ShellInvocation {
  return {
    shell,
    args: ['/d', '/s', '/c', `"${command}"`],
    dialect: 'cmd',
    windowsVerbatimArguments: true,
  };
}

function posixShellInvocation(command: string, shell: string): ShellInvocation {
  return { shell, args: ['-c', command], dialect: 'posix', windowsVerbatimArguments: false };
}

export function shellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  piShell?: PiShellConfig,
): ShellInvocation {
  if (piShell !== undefined) {
    return {
      shell: piShell.shell,
      args:
        piShell.commandTransport === 'stdin'
          ? [...piShell.args]
          : [...piShell.args, command],
      dialect: 'posix',
      windowsVerbatimArguments: false,
      ...(piShell.commandTransport === 'stdin' ? { stdinCommand: command } : {}),
    };
  }

  if (platform !== 'win32') {
    const shell = env['SHELL'];
    return posixShellInvocation(command, shell && shell.length > 0 ? shell : '/bin/sh');
  }

  const requestedShell = env['PI_BG_SHELL'];
  const requestedPath = env['PI_BG_SHELL_PATH'];
  if (requestedShell === undefined) {
    if (requestedPath !== undefined) failShellInvocation('PI_BG_SHELL_PATH requires PI_BG_SHELL');
    const comSpec = env['ComSpec'];
    return cmdShellInvocation(command, comSpec && comSpec.length > 0 ? comSpec : 'cmd.exe');
  }
  if (requestedShell !== 'cmd' && requestedShell !== 'bash') {
    failShellInvocation('PI_BG_SHELL must be exactly cmd or bash');
  }
  const explicitPath =
    requestedPath !== undefined ? validateWindowsShellPath(requestedPath, 'PI_BG_SHELL_PATH') : undefined;
  if (requestedShell === 'cmd') {
    const comSpec = env['ComSpec'];
    return cmdShellInvocation(command, explicitPath ?? (comSpec && comSpec.length > 0 ? comSpec : 'cmd.exe'));
  }
  return posixShellInvocation(command, explicitPath ?? resolveWindowsBash(env));
}

export function normalizeMaxBytes(value: unknown, fallback = DEFAULT_LOG_BYTES): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(MAX_LOG_BYTES, raw));
}

export function snapshot(task: BgTask): BgTaskSnapshot {
  return {
    id: task.id,
    name: taskDisplayName(task),
    command: task.command,
    description: task.description,
    status: task.status,
    outputPath: task.outputPath,
    cwd: task.cwd,
    startTime: task.startTime,
    endTime: task.endTime,
    exitCode: task.exitCode,
    signal: task.signal,
    pid: task.pid,
    bytesWritten: task.bytesWritten,
    error: task.error,
    notified: task.notified,
    notifyOnCompletion: task.notifyOnCompletion,
    triggerOnCompletion: task.triggerOnCompletion,
    timeoutSeconds: task.timeoutSeconds,
  };
}

export function formatSnapshotList(tasks: BgTaskSnapshot[], now = Date.now()): string {
  if (tasks.length === 0) return 'No background tasks in this Pi extension runtime.';
  return tasks
    .map((task) => {
      const statusIcon =
        task.status === 'running'
          ? '▶'
          : task.status === 'completed'
            ? '✓'
            : task.status === 'killed'
              ? '■'
              : '✗';
      const age = formatDuration((task.endTime ?? now) - task.startTime);
      const code = task.exitCode !== undefined ? ` exit=${String(task.exitCode)}` : '';
      const pid = task.pid !== undefined ? ` pid=${String(task.pid)}` : '';
      const error = task.error ? ` error=${truncateChars(task.error, 80)}` : '';
      return `${statusIcon} ${task.id} ${task.status} ${age}${code}${pid} — ${truncateChars(taskDisplayName(task), COMMAND_PREVIEW_CHARS)}${error}\n    output: ${task.outputPath}`;
    })
    .join('\n');
}

export async function boundedRead(
  filePath: string,
  maxBytes: number,
  tail: boolean,
): Promise<{ content: string; truncated: boolean; bytesRead: number; totalBytes: number }> {
  const stats = statSync(filePath);
  const totalBytes = stats.size;
  const bytesToRead = Math.min(totalBytes, maxBytes);
  if (bytesToRead === 0) return { content: '', truncated: false, bytesRead: 0, totalBytes };

  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const position = tail ? Math.max(0, totalBytes - bytesToRead) : 0;
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
    return {
      content: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: totalBytes > bytesRead,
      bytesRead,
      totalBytes,
    };
  } finally {
    await file.close();
  }
}

export function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
