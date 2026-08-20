import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ThemeColor,
  ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import { formatSize, getShellConfig, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Text, type KeyId } from '@earendil-works/pi-tui';
import { Type, type Static } from 'typebox';
import {
  DEFAULT_LOG_BYTES,
  MAX_LOG_BYTES,
  deriveCompletionDeliveryGuidance,
  deriveTaskNameFromCommand,
  formatSnapshotList,
  normalizeMaxBytes,
  normalizeTaskName,
  parseBgCommandArgs,
  taskDisplayName,
  truncateChars,
  type BgKillDetails,
  type BgLogsDetails,
  type BgRunDetails,
  type BgStatusDetails,
  type BgTask,
  type BgTaskSnapshot,
  type StartTaskOptions,
} from './core/common.js';
import { BackgroundTaskRegistry } from './core/registry.js';
import {
  installBackgroundTaskExtensionApi,
  type BackgroundTaskExtensionService,
} from './core/extension-api.js';
import {
  BACKGROUND_TASKS_OVERLAY_OPTIONS,
  BackgroundTasksManager,
  type BackgroundTaskForUi,
  type TaskManagerResult,
} from './ui/background-tasks-manager.js';

/**
 * Project-local Pi background task manager.
 *
 * Scope:
 * - Explicit background shell jobs only: /bg and bg_run spawn commands directly.
 * - No Ctrl+B support for backgrounding an already-running built-in bash tool.
 * - No detached/restart reattachment: live child processes belong to this Pi
 *   extension runtime and are killed on session shutdown/reload.
 */

const STATUS_INTERVAL_MS = 1000;
const COMMAND_PREVIEW_CHARS = 90;
const FOOTER_LABEL_FG = '\x1b[38;2;0;175;175m';
const ANSI_RESET = '\x1b[0m';
// Pi exposes no shared token for the tool-branch color.
const TOOL_BRANCH_FG = '\x1b[38;2;72;72;72m';
const ANSI_FG_RESET = '\x1b[39m';

function backgroundTaskContext(ctx: ExtensionContext) {
  const shellPath = SettingsManager.create(ctx.cwd).getShellPath();
  return { ...ctx, piShell: getShellConfig(shellPath) };
}

function notificationColor(status: BgTaskSnapshot['status']): ThemeColor {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'killed') return 'warning';
  return 'accent';
}

function notificationLabel(status: BgTaskSnapshot['status']): string {
  if (status === 'killed') return 'Stopped';
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

function notificationIcon(status: BgTaskSnapshot['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'failed') return '✗';
  if (status === 'killed') return '■';
  return '●';
}

function notificationDuration(task: BgTaskSnapshot | undefined): string {
  if (!task?.endTime) return '—';
  const milliseconds = Math.max(0, task.endTime - task.startTime);
  if (milliseconds < 60_000)
    return `${String(Math.max(0.1, Math.round(milliseconds / 100) / 10))}s`;
  return `${String(Math.floor(milliseconds / 60_000))}m ${String(Math.round((milliseconds % 60_000) / 1000))}s`;
}

function notificationOutputSize(task: BgTaskSnapshot | undefined): string {
  return task?.bytesWritten ? formatSize(task.bytesWritten) : 'no output';
}

function renderBackgroundTaskNotification(task: BgTaskSnapshot | undefined, theme: Theme): Text {
  const status = task?.status ?? 'completed';
  const exitCode =
    status === 'failed' && task?.exitCode !== undefined && task.exitCode !== null
      ? ` · exit ${String(task.exitCode)}`
      : '';
  const name = truncateChars(task ? taskDisplayName(task) : 'Background task', 48);
  const headline = `${theme.fg(notificationColor(status), theme.bold(`${notificationIcon(status)} ${notificationLabel(status)}${exitCode}`))} ${theme.fg('customMessageText', name)}`;
  const logs = theme.fg('dim', `/logs ${task?.id ?? 'background task'}`);
  const detail =
    theme.fg('dim', `${notificationDuration(task)} · ${notificationOutputSize(task)} · `) + logs;
  return new Text(` ${headline}\n ${TOOL_BRANCH_FG}└─${ANSI_FG_RESET} ${detail}`, 0, 0);
}

function footerLabel(value: string): string {
  return `${FOOTER_LABEL_FG}${value}${ANSI_RESET}`;
}

function footerText(theme: Theme | undefined, color: ThemeColor, value: string): string {
  if (!theme) return value;
  try {
    return theme.fg(color, value);
  } catch {
    // Headless hosts can expose a Theme before its terminal palette is initialized.
    return value;
  }
}

function footerStatus(
  theme: Theme | undefined,
  status: BgTaskSnapshot['status'],
  value: string,
): string {
  return footerText(theme, notificationColor(status), value);
}

function textContent(text: string) {
  return [{ type: 'text' as const, text }];
}

interface TextToolResult {
  content?: ReadonlyArray<{ type: string; text?: string }>;
}

interface BgToolArgumentRecord {
  readonly command?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly timeoutSeconds?: unknown;
  readonly notifyOnCompletion?: unknown;
  readonly triggerOnCompletion?: unknown;
}

function optionalTrimmed(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const BgRunParams = Type.Object({
  name: Type.String({
    description:
      'Short human-readable task name shown in the bg footer dock. Required; use 2-6 words, not the raw command.',
  }),
  command: Type.String({ description: 'Shell command to start in the background' }),
  description: Type.Optional(
    Type.String({ description: 'Optional longer human-readable context for the task' }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({ description: 'Optional timeout; task is failed and killed when exceeded' }),
  ),
  notifyOnCompletion: Type.Optional(
    Type.Boolean({
      description:
        'Whether to deliver the durable terminal notification. Default: true; disable only when deliberately taking over completion monitoring.',
    }),
  ),
  triggerOnCompletion: Type.Optional(
    Type.Boolean({
      description:
        'Whether that notification should start an agent turn when Pi is idle. Default: true for bg_run; requires notifyOnCompletion. Active runs receive the notification through steering.',
    }),
  ),
});

const BgStatusParams = Type.Object({
  taskId: Type.Optional(
    Type.String({
      description:
        'Optional task ID or unambiguous prefix. If omitted, all running/recent tasks are returned.',
    }),
  ),
});

const BgLogsParams = Type.Object({
  taskId: Type.String({ description: 'Task ID or unambiguous prefix' }),
  maxBytes: Type.Optional(
    Type.Number({
      description: `Maximum bytes to return, capped at ${formatSize(MAX_LOG_BYTES)}. Default: ${formatSize(DEFAULT_LOG_BYTES)}.`,
    }),
  ),
  tail: Type.Optional(
    Type.Boolean({
      description: 'Read the tail of the log when true, head when false. Default: true.',
    }),
  ),
});

const BgKillParams = Type.Object({
  taskId: Type.String({ description: 'Task ID or unambiguous prefix to stop' }),
});

type BgRunParamsValue = Static<typeof BgRunParams>;

function renderPlainResult(result: TextToolResult, options: ToolRenderResultOptions, theme: Theme) {
  void options;
  void theme;
  const text =
    result.content?.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('\n') ?? '';
  return new Text(text, 0, 0);
}

export default function backgroundTasksExtension(pi: ExtensionAPI): void {
  const seenTaskIds = new Set<string>();
  let currentCtx: ExtensionContext | undefined;
  let statusInterval: NodeJS.Timeout | undefined;

  let eventService: BackgroundTaskExtensionService | undefined;
  const registry = new BackgroundTaskRegistry({
    onChange: () => {
      updateUi();
    },
    sendCompletionNotification: (message, options) => {
      pi.sendMessage(message, options);
    },
    publishTerminal: (task) => {
      if (!eventService) throw new Error('Background task EventBus service is not installed');
      eventService.publishTerminal(task);
    },
  });
  eventService = installBackgroundTaskExtensionApi({
    events: pi.events,
    registry,
    getContext: () =>
      currentCtx === undefined ? undefined : backgroundTaskContext(currentCtx),
    isShuttingDown: () => registry.isShuttingDown(),
  });

  function unseenFinishedTasks(): BgTask[] {
    return registry
      .allTasks()
      .filter((task) => task.status !== 'running' && !seenTaskIds.has(task.id));
  }

  function clearFinishedNotices(ctx = currentCtx): number {
    const unseen = unseenFinishedTasks();
    for (const task of unseen) seenTaskIds.add(task.id);
    updateUi(ctx);
    return unseen.length;
  }

  function notifyClearFinishedNotices(ctx: ExtensionContext): void {
    currentCtx = ctx;
    const cleared = clearFinishedNotices(ctx);
    if (!ctx.hasUI) return;
    ctx.ui.notify(
      cleared > 0
        ? `Cleared ${String(cleared)} finished background task notice${cleared === 1 ? '' : 's'}.`
        : 'No finished background task notices to clear.',
      cleared > 0 ? 'info' : 'warning',
    );
  }

  function updateUi(ctx = currentCtx): void {
    if (registry.isShuttingDown() || !ctx) return;
    try {
      if (!ctx.hasUI) return;
      const allTasks = registry.allTasks();
      const running = allTasks.filter((task) => task.status === 'running');
      const unseenFailed = allTasks.filter(
        (task) => task.status === 'failed' && !seenTaskIds.has(task.id),
      );
      const unseenStopped = allTasks.filter(
        (task) => task.status === 'killed' && !seenTaskIds.has(task.id),
      );
      const unseenDone = allTasks.filter(
        (task) => task.status === 'completed' && !seenTaskIds.has(task.id),
      );
      const unseenFinishedCount = unseenFailed.length + unseenStopped.length + unseenDone.length;
      ctx.ui.setWidget('background-tasks', undefined);
      if (running.length === 0 && unseenFinishedCount === 0) {
        ctx.ui.setStatus('background-tasks', undefined);
        return;
      }

      const statuses = [
        running.length > 0
          ? footerStatus(ctx.ui.theme, 'running', `${String(running.length)}▶`)
          : undefined,
        unseenFailed.length > 0
          ? footerStatus(ctx.ui.theme, 'failed', `${String(unseenFailed.length)}✗`)
          : undefined,
        unseenStopped.length > 0
          ? footerStatus(ctx.ui.theme, 'killed', `${String(unseenStopped.length)}■`)
          : undefined,
        unseenDone.length > 0
          ? footerStatus(ctx.ui.theme, 'completed', `${String(unseenDone.length)}✓`)
          : undefined,
      ]
        .filter((status): status is string => status !== undefined)
        .join(' ');
      const label = `${footerLabel('bg')} ${statuses}`;
      ctx.ui.setStatus('background-tasks', label);
    } catch (error) {
      console.error(
        `[background-tasks] UI update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      currentCtx = undefined;
    }
  }

  async function startTask(
    ctx: ExtensionContext,
    command: string,
    options: StartTaskOptions = {},
  ): Promise<BgTask> {
    currentCtx = ctx;
    return registry.startTask(backgroundTaskContext(ctx), command, options);
  }

  async function openTaskManager(
    ctx: ExtensionCommandContext | ExtensionContext,
    initialTaskId?: string,
  ): Promise<void> {
    currentCtx = ctx;
    if (!ctx.hasUI) {
      ctx.ui.notify(
        'Background task manager requires an interactive Pi UI. Use /jobs, /logs, or the bg_status/bg_logs tools in non-interactive mode.',
        'error',
      );
      return;
    }
    updateUi(ctx);
    try {
      await ctx.ui.custom<TaskManagerResult>(
        (tui, theme, _keybindings, done) => {
          const managerOptions = {
            getTasks: () => registry.allTasks(),
            stopTask: async (task: BackgroundTaskForUi) => {
              await registry.stopTask(registry.resolveTask(task.id), 'user');
              updateUi(ctx);
            },
            stopAllRunning: async () => {
              const result = await registry.stopAllRunning('user');
              updateUi(ctx);
              return result;
            },
            rerunTask: async (task: BackgroundTaskForUi) => {
              const rerunOptions: StartTaskOptions = {
                name: taskDisplayName(task),
                notifyOnCompletion: true,
                triggerOnCompletion: false,
              };
              if (task.description !== undefined) rerunOptions.description = task.description;
              if (task.timeoutSeconds !== undefined)
                rerunOptions.timeoutSeconds = task.timeoutSeconds;
              const rerun = await startTask(ctx, task.command, rerunOptions);
              updateUi(ctx);
              return rerun;
            },
            showOutputPath: (task: BackgroundTaskForUi) => {
              ctx.ui.notify(
                `Output path for ${taskDisplayName(task)} (${task.id}):\n${task.outputPath}`,
                'info',
              );
            },
            markSeen: (taskId: string) => {
              seenTaskIds.add(taskId);
              updateUi(ctx);
            },
            markFinishedSeen: (taskIds: string[]) => {
              for (const taskId of taskIds) seenTaskIds.add(taskId);
              updateUi(ctx);
            },
            isSeen: (taskId: string) => seenTaskIds.has(taskId),
          };
          if (initialTaskId)
            return new BackgroundTasksManager(tui, theme, done, {
              ...managerOptions,
              initialTaskId,
            });
          return new BackgroundTasksManager(tui, theme, done, managerOptions);
        },
        {
          overlay: true,
          overlayOptions: BACKGROUND_TASKS_OVERLAY_OPTIONS,
        },
      );
    } finally {
      updateUi(ctx);
    }
  }

  pi.registerMessageRenderer<BgTaskSnapshot>(
    'background-task-notification',
    (message, _options, theme) => renderBackgroundTaskNotification(message.details, theme),
  );

  pi.on('session_start', async (_event, ctx) => {
    registry.setShuttingDown(false);
    currentCtx = ctx;
    await registry.ensureRuntimeDir(ctx);
    updateUi(ctx);
    if (statusInterval) clearInterval(statusInterval);
    statusInterval = setInterval(() => {
      updateUi();
    }, STATUS_INTERVAL_MS);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    registry.setShuttingDown(true);
    currentCtx = undefined;
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = undefined;
    }
    try {
      const running = registry.allTasks().filter((task) => task.status === 'running');
      if (running.length === 0) return;

      const failures: string[] = [];
      await Promise.all(
        running.map(async (task) => {
          try {
            await registry.stopTask(task, 'shutdown', 'Killed during Pi session shutdown/reload');
          } catch (error) {
            const message = `${task.id}: ${error instanceof Error ? error.message : String(error)}`;
            failures.push(message);
            console.error(`[background-tasks] shutdown cleanup failed for ${message}`);
          }
        }),
      );
      if (failures.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`Background task cleanup failed:\n${failures.join('\n')}`, 'error');
      }
    } finally {
      eventService?.close();
    }
  });

  pi.registerCommand('bg', {
    description: 'Start a shell command as a tracked background task: /bg [--name "Task name"] <command>',
    handler: async (args, ctx) => {
      try {
        const parsed = parseBgCommandArgs(args);
        const taskOptions: StartTaskOptions = {
          notifyOnCompletion: true,
          triggerOnCompletion: false,
        };
        if (parsed.name !== undefined) taskOptions.name = parsed.name;
        const task = await startTask(ctx, parsed.command, taskOptions);
        ctx.ui.notify(
          `Started ${taskDisplayName(task)} (${task.id})\nOutput: ${task.outputPath}\nCommand: ${task.command}`,
          'info',
        );
      } catch (error) {
        ctx.ui.notify(
          `Background task failed to start: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });

  pi.registerCommand('tasks', {
    description: 'Open the Claude-like background task manager UI',
    handler: async (args, ctx) => {
      const taskId = optionalTrimmed(args);
      await openTaskManager(ctx, taskId);
    },
  });

  pi.registerCommand('bg-tasks', {
    description: 'Open the background task manager UI',
    handler: async (args, ctx) => {
      const taskId = optionalTrimmed(args);
      await openTaskManager(ctx, taskId);
    },
  });

  pi.registerCommand('bg-clear', {
    description: 'Clear finished background task footer notices',
    handler: (_args, ctx) => {
      notifyClearFinishedNotices(ctx);
      return Promise.resolve();
    },
  });

  pi.registerShortcut('shift+down' satisfies KeyId, {
    description: 'Open focused background task footer dock',
    handler: async (ctx) => {
      await openTaskManager(ctx);
    },
  });

  pi.registerShortcut('ctrl+alt+c' satisfies KeyId, {
    description:
      'Clear finished background task footer notices (terminal-dependent fallback for /bg-clear)',
    handler: (ctx) => {
      notifyClearFinishedNotices(ctx);
    },
  });

  pi.registerCommand('jobs', {
    description: 'List running and recent background tasks',
    handler: (_args, ctx) => {
      currentCtx = ctx;
      ctx.ui.notify(
        formatSnapshotList(registry.allTasks().map((task) => registry.snapshot(task))),
        'info',
      );
      updateUi(ctx);
      return Promise.resolve();
    },
  });

  pi.registerCommand('logs', {
    description: 'Show bounded output from a background task: /logs <id> [maxBytes]',
    getArgumentCompletions: (prefix) => {
      const matches = registry
        .allTasks()
        .filter((task) => task.id.startsWith(prefix.trim()))
        .slice(0, 20)
        .map((task) => ({
          value: task.id,
          label: `${task.id} ${taskDisplayName(task)}`,
          description: `${task.status} — ${truncateChars(task.command, 60)}`,
        }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      try {
        currentCtx = ctx;
        const [id, bytes] = args.trim().split(/\s+/, 2);
        const task = registry.resolveTask(id ?? '');
        const maxBytes = normalizeMaxBytes(Number(bytes), DEFAULT_LOG_BYTES);
        const logs = await registry.getTaskLogs(task, maxBytes, true);
        ctx.ui.notify(logs.text, 'info');
      } catch (error) {
        ctx.ui.notify(
          `Background logs error: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });

  pi.registerCommand('kill', {
    description: 'Stop a running background task: /kill <id>',
    getArgumentCompletions: (prefix) => {
      const matches = registry
        .allTasks()
        .filter((task) => task.status === 'running' && task.id.startsWith(prefix.trim()))
        .slice(0, 20)
        .map((task) => ({
          value: task.id,
          label: `${task.id} ${taskDisplayName(task)}`,
          description: truncateChars(task.command, 70),
        }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      try {
        currentCtx = ctx;
        const task = registry.resolveTask(args.trim());
        await registry.stopTask(task, 'user');
        ctx.ui.notify(
          `Killed ${taskDisplayName(task)} (${task.id}). Output: ${task.outputPath}`,
          'info',
        );
        updateUi(ctx);
      } catch (error) {
        ctx.ui.notify(
          `Background kill error: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });

  pi.registerTool<typeof BgRunParams, BgRunDetails>({
    name: 'bg_run',
    label: 'Background Run',
    description: `Start a named long-running shell command in the background and return immediately with a task ID and output path. By default, completed, failed, or killed terminal state is delivered automatically as <background-task-notification>. It is steered into the next model-call boundary while the agent is active, or starts a new turn when Pi is idle; do not sleep or poll merely to wait. Output is written to the system temporary directory and model-visible logs are bounded to ${formatSize(MAX_LOG_BYTES)}.`,
    promptSnippet:
      'Start a named long-running shell command; default terminal notification steers active work or wakes an idle agent',
    promptGuidelines: [
      'Use bg_run instead of bash for commands expected to run for a long time, such as test suites, dev servers, watchers, or builds.',
      'When using bg_run, always set name to a concise 2-6 word human-readable label for the footer task dock; do not use the raw command as the name unless it is already short and meaningful.',
      'bg_run returns immediately. With notifyOnCompletion:true and triggerOnCompletion:true (both defaults), completed, failed, or killed terminal state is delivered as <background-task-notification>, steered into the next model-call boundary during active work, or starts a new turn when Pi is idle.',
      'After a default bg_run launch, continue only independent useful work that does not merely wait for the task; otherwise briefly acknowledge it if useful, then end the current turn. Do not call sleep, bg_status, or bg_logs merely to wait; the terminal notification will reach the agent automatically.',
      'Treat <background-task-notification> as durable terminal truth. Do not call bg_status to reconfirm it; call bg_logs only when the task output is needed.',
      'Use bg_status/bg_logs only when the user explicitly requests an update, automatic notification or wake-up was deliberately disabled, there is concrete evidence the task is hung, or a terminal notification arrived and output details are needed.',
      'Do not set notifyOnCompletion:false or triggerOnCompletion:false unless intentionally opting out of automatic completion handling.',
    ],
    parameters: BgRunParams,
    prepareArguments(args): BgRunParamsValue {
      if (!args || typeof args !== 'object') throw new Error('bg_run arguments must be an object');
      const input = args as BgToolArgumentRecord;
      if (typeof input.command !== 'string') throw new Error('bg_run requires command string');
      const prepared: BgRunParamsValue = {
        command: input.command,
        name:
          normalizeTaskName(input.name) ??
          normalizeTaskName(input.description) ??
          deriveTaskNameFromCommand(input.command),
      };
      if (typeof input.description === 'string') prepared.description = input.description;
      if (typeof input.timeoutSeconds === 'number') prepared.timeoutSeconds = input.timeoutSeconds;
      if (typeof input.notifyOnCompletion === 'boolean')
        prepared.notifyOnCompletion = input.notifyOnCompletion;
      if (typeof input.triggerOnCompletion === 'boolean')
        prepared.triggerOnCompletion = input.triggerOnCompletion;
      return prepared;
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as BgRunParamsValue;
      const taskOptions: StartTaskOptions = {
        name: input.name,
        notifyOnCompletion: input.notifyOnCompletion ?? true,
        triggerOnCompletion: input.triggerOnCompletion ?? true,
      };
      if (input.description !== undefined) taskOptions.description = input.description;
      if (input.timeoutSeconds !== undefined) taskOptions.timeoutSeconds = input.timeoutSeconds;
      const task = await startTask(ctx, input.command, taskOptions);
      const completionDelivery = deriveCompletionDeliveryGuidance(
        task.notifyOnCompletion,
        task.triggerOnCompletion,
      );
      return {
        content: textContent(
          `Started background task ${taskDisplayName(task)} (${task.id})\nStatus: ${task.status}\nPID: ${String(task.pid ?? 'unknown')}\nOutput: ${task.outputPath}\n${completionDelivery.text}`,
        ),
        details: { task: registry.snapshot(task) },
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('bg_run '))}${theme.fg('muted', truncateChars(taskDisplayName(args), COMMAND_PREVIEW_CHARS))}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const { task } = result.details;
      return new Text(
        `${theme.fg('success', '✓ started')} ${theme.fg('accent', taskDisplayName(task))} ${theme.fg('dim', `(${task.id})`)}\n${theme.fg('dim', `Output: ${task.outputPath}`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool<typeof BgStatusParams, BgStatusDetails>({
    name: 'bg_status',
    label: 'Background Status',
    description:
      'Inspect one background task or list all running/recent background tasks. This is a point-in-time inspection tool, not a waiting primitive.',
    promptSnippet:
      'Inspect point-in-time status for one or all background tasks; never poll it as a wait loop',
    promptGuidelines: [
      'Use bg_status for deliberate point-in-time inspection, not as a waiting primitive.',
      'A running result is not an instruction to poll again. Do not repeatedly call bg_status while an automatic terminal notification is pending.',
      'Use bg_status when the user explicitly requests an update, automatic completion handling was disabled, or concrete evidence suggests a task is hung; terminal notifications do not need reconfirmation.',
    ],
    parameters: BgStatusParams,
    execute(_toolCallId, params) {
      const selected = params.taskId ? [registry.resolveTask(params.taskId)] : registry.allTasks();
      const snapshots = selected.map((task) => registry.snapshot(task));
      return Promise.resolve({
        content: textContent(formatSnapshotList(snapshots)),
        details: { tasks: snapshots },
      });
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('bg_status'))}${args.taskId ? ` ${theme.fg('accent', args.taskId)}` : ''}`,
        0,
        0,
      );
    },
    renderResult: renderPlainResult,
  });

  pi.registerTool<typeof BgLogsParams, BgLogsDetails>({
    name: 'bg_logs',
    label: 'Background Logs',
    description: `Read bounded output from a background task for deliberate inspection; this is not a waiting primitive. Output is capped at ${formatSize(MAX_LOG_BYTES)} for model safety and points to the full output file when truncated.`,
    promptSnippet: 'Read bounded task output when needed; never tail it repeatedly as a wait loop',
    promptGuidelines: [
      'Use bg_logs with a modest maxBytes value only when task output is needed, without flooding context.',
      'Do not repeatedly call bg_logs to wait for completion while an automatic terminal notification is pending.',
      'Use bg_status first only when a deliberate inspection requires the current task state; do not reconfirm a terminal notification.',
    ],
    parameters: BgLogsParams,
    async execute(_toolCallId, params) {
      const task = registry.resolveTask(params.taskId);
      const logs = await registry.getTaskLogs(
        task,
        normalizeMaxBytes(params.maxBytes),
        params.tail ?? true,
      );
      return {
        content: textContent(logs.text),
        details: logs.details,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('bg_logs '))}${theme.fg('accent', args.taskId)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details;
      let text = `${theme.fg('accent', taskDisplayName(details.task))} ${theme.fg('dim', `(${details.task.id})`)} ${theme.fg('muted', details.tail ? 'tail' : 'head')} ${formatSize(details.bytesRead)}`;
      if (details.truncated) text += theme.fg('warning', ' (truncated)');
      text += `\n${theme.fg('dim', `Full output: ${details.path}`)}`;
      if (expanded) {
        const output = result.content
          .map((content) => (content.type === 'text' ? content.text : '[image content]'))
          .join('\n');
        text += `\n${theme.fg('toolOutput', output.split('\n').slice(0, 30).join('\n'))}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool<typeof BgKillParams, BgKillDetails>({
    name: 'bg_kill',
    label: 'Background Kill',
    description:
      'Stop a running background task by ID. Fails loudly if the task is unknown or already finished.',
    promptSnippet: 'Stop a running background task by ID',
    promptGuidelines: [
      'Use bg_kill when the user asks to stop a background task or when a bg_run command is no longer needed.',
    ],
    parameters: BgKillParams,
    async execute(_toolCallId, params) {
      const task = registry.resolveTask(params.taskId);
      await registry.stopTask(task, 'user');
      const message = `Killed background task ${taskDisplayName(task)} (${task.id}). Output: ${task.outputPath}`;
      return {
        content: textContent(message),
        details: { task: registry.snapshot(task), message },
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg('toolTitle', theme.bold('bg_kill '))}${theme.fg('accent', args.taskId)}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const { task } = result.details;
      return new Text(
        `${theme.fg('warning', '■ killed')} ${theme.fg('accent', taskDisplayName(task))} ${theme.fg('dim', `(${task.id})`)}\n${theme.fg('dim', `Output: ${task.outputPath}`)}`,
        0,
        0,
      );
    },
  });
}
