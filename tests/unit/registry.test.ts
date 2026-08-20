import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJsonText } from '../../src/core/common.js';
import {
  BackgroundTaskRegistry,
  type BackgroundTaskContext,
  type BackgroundTaskSpawn,
  type CompletionNotificationMessage,
  type CompletionNotificationOptions,
} from '../../src/core/registry.js';
import type { BgTask, BgTaskSnapshot } from '../../src/core/common.js';
import type { TaskkillOutcome, WindowsKillPhase } from '../../src/core/windows-taskkill.js';

type JsonObject = Record<PropertyKey, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string, message: string): JsonObject {
  const parsed = parseJsonText(text);
  assert.ok(isJsonObject(parsed), message);
  return parsed;
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number;
  killCalls: Array<NodeJS.Signals | undefined> = [];
  killImpl: (signal?: NodeJS.Signals) => boolean;

  constructor(pid: number, killImpl?: (signal?: NodeJS.Signals) => boolean) {
    super();
    this.pid = pid;
    this.killImpl = killImpl ?? (() => true);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    return this.killImpl(signal);
  }

  writeStdout(value: string): void {
    this.stdout.emit('data', Buffer.from(value, 'utf8'));
  }

  writeStderr(value: string): void {
    this.stderr.emit('data', Buffer.from(value, 'utf8'));
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit('close', code, signal);
  }

  fail(error: Error): void {
    this.emit('error', error);
  }
}

interface SpawnRecord {
  child: FakeChild;
  shell: string;
  args: string[];
  options: Parameters<BackgroundTaskSpawn>[2];
}

interface HarnessOptions {
  platform?: NodeJS.Platform;
  maxRecentTasks?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
  stopWaitMs?: number;
  killProcess?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  killTree?: (
    pid: number,
    phase: WindowsKillPhase,
    signal?: AbortSignal,
  ) => Promise<TaskkillOutcome>;
  sendCompletionNotification?: (
    message: CompletionNotificationMessage,
    options: CompletionNotificationOptions,
  ) => void;
  publishTerminal?: (task: BgTaskSnapshot) => void;
  logger?: Pick<Console, 'error'>;
  makeTaskId?: () => string;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  childFactory?: (pid: number) => FakeChild;
}

async function createHarness(options: HarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-registry-'));
  const cwd = join(root, 'project');
  await mkdir(cwd, { recursive: true });
  let pid = 4200;
  let idSeq = 0;
  const children: SpawnRecord[] = [];
  const notifications: Array<{
    message: CompletionNotificationMessage;
    options: CompletionNotificationOptions;
  }> = [];
  const errors: unknown[][] = [];
  let changes = 0;
  const registryOptions: ConstructorParameters<typeof BackgroundTaskRegistry>[0] = {
    logger: options.logger ?? {
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    },
    makeTaskId: options.makeTaskId ?? (() => `bunit${String(++idSeq).padStart(3, '0')}`),
    sendCompletionNotification:
      options.sendCompletionNotification ??
      ((message, opts) => {
        notifications.push({ message, options: opts });
      }),
    onChange: () => {
      changes++;
    },
    spawn: (shell, args, spawnOptions) => {
      const child = options.childFactory?.(++pid) ?? new FakeChild(++pid);
      children.push({ child, shell, args: [...args], options: spawnOptions });
      return child;
    },
  };
  if (options.publishTerminal !== undefined)
    registryOptions.publishTerminal = options.publishTerminal;
  if (options.platform !== undefined) registryOptions.platform = options.platform;
  if (options.env !== undefined) registryOptions.env = options.env;
  if (options.maxRecentTasks !== undefined) registryOptions.maxRecentTasks = options.maxRecentTasks;
  if (options.maxOutputBytes !== undefined) registryOptions.maxOutputBytes = options.maxOutputBytes;
  if (options.killGraceMs !== undefined) registryOptions.killGraceMs = options.killGraceMs;
  if (options.stopWaitMs !== undefined) registryOptions.stopWaitMs = options.stopWaitMs;
  if (options.now !== undefined) registryOptions.now = options.now;
  if (options.killProcess !== undefined) registryOptions.killProcess = options.killProcess;
  if (options.killTree !== undefined) registryOptions.killTree = options.killTree;
  const registry = new BackgroundTaskRegistry(registryOptions);
  const ctx: BackgroundTaskContext = {
    cwd,
    sessionId: 'registry-test',
  };
  return {
    root,
    cwd,
    ctx,
    registry,
    children,
    notifications,
    errors,
    get changes() {
      return changes;
    },
  };
}
async function cleanup(root: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/ENOTEMPTY/.test(error.message) || attempt === 4)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function waitFor(
  predicate: () => boolean,
  message = 'condition',
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function lastSpawn(h: Awaited<ReturnType<typeof createHarness>>): SpawnRecord {
  const spawn = h.children.at(-1);
  assert.ok(spawn, 'test harness should have recorded a child process spawn');
  return spawn;
}

function taskkillOutcome(exitCode: number | null, stderr = ''): TaskkillOutcome {
  return {
    exitCode,
    signal: null,
    stdout: '',
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | undefined;
  let rejectFn: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  assert.ok(resolveFn, 'deferred resolve should initialize');
  assert.ok(rejectFn, 'deferred reject should initialize');
  return { promise, resolve: resolveFn, reject: rejectFn };
}

function isKillRequester(
  value: unknown,
): value is (task: BgTask, signal?: NodeJS.Signals) => void {
  return typeof value === 'function';
}

function requestKillForTest(
  registry: BackgroundTaskRegistry,
  task: BgTask,
  signal?: NodeJS.Signals,
): void {
  const method = Reflect.get(registry, 'requestKill');
  assert.ok(isKillRequester(method), 'registry requestKill should be callable');
  method.call(registry, task, signal);
}

async function startFakeTask(
  h: Awaited<ReturnType<typeof createHarness>>,
  name = 'Registry Task',
): Promise<{ task: BgTask; child: FakeChild }> {
  const task = await h.registry.startTask(h.ctx, 'node fake.js', {
    name,
    notifyOnCompletion: true,
    triggerOnCompletion: true,
  });
  return { task, child: lastSpawn(h).child };
}

void describe('BackgroundTaskRegistry', () => {
  void it('stores task output artifacts in the system temporary directory', async () => {
    const h = await createHarness();
    let task: BgTask | undefined;
    try {
      const started = await startFakeTask(h);
      task = started.task;
      const outputRoot = join(tmpdir(), 'pi-bg-tasks');
      assert.equal(dirname(dirname(task.outputPath)), outputRoot);
      assert.equal(dirname(dirname(task.outputAbsPath)), outputRoot);
      assert.equal(dirname(dirname(task.metadataAbsPath)), outputRoot);
      assert.equal(task.outputPath, task.outputAbsPath);
      assert.equal(task.outputPath.startsWith(h.cwd), false);
      await waitFor(() => existsSync(task!.outputAbsPath), 'output file creation');
      started.child.close(0, null);
      await waitFor(() => task!.status === 'completed', 'task completion');
    } finally {
      if (task) await rm(dirname(task.outputAbsPath), { recursive: true, force: true });
      await cleanup(h.root);
    }
  });

  void it('preserves full shell command bytes except surrounding whitespace', async () => {
    const h = await createHarness({ platform: 'linux' });
    try {
      const command = `'${process.execPath}' '${join(h.cwd, 'bin', 'autopilot-agent-run.mjs')}' --spec '${join(h.cwd, 'specs', 'unit spec.json')}'`;
      const task = await h.registry.startTask(h.ctx, `  ${command}  `, {
        name: 'Quoted Runner',
        notifyOnCompletion: false,
      });
      const spawn = lastSpawn(h);
      assert.equal(task.command, command);
      assert.equal(spawn.args.at(-1), command);
      assert.equal(JSON.parse(readFileSync(task.metadataAbsPath, 'utf8')).command, command);
      assert.equal(Object.hasOwn(task, 'isAgent'), false);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('uses Pi shell configuration instead of the ambient shell', async () => {
    const h = await createHarness({ platform: 'darwin', env: { SHELL: '/opt/homebrew/bin/nu' } });
    try {
      const ctx = {
        ...h.ctx,
        piShell: { shell: '/opt/homebrew/bin/bash', args: ['-c'] },
      } as BackgroundTaskContext;
      await h.registry.startTask(ctx, 'echo shell', { name: 'Configured Shell' });
      const spawn = lastSpawn(h);
      assert.equal(spawn.shell, '/opt/homebrew/bin/bash');
      assert.deepEqual(spawn.args, ['-c', 'echo shell']);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('rejects unresolved Windows bash without spawning and records a failed task', async () => {
    const h = await createHarness({ platform: 'win32', env: { PI_BG_SHELL: 'bash', PATH: '' } });
    try {
      await assert.rejects(
        h.registry.startTask(h.ctx, 'echo ok', { name: 'Bad Bash', notifyOnCompletion: false }),
        /could not resolve bash/,
      );
      assert.equal(h.children.length, 0);
      const failed = h.registry.allTasks();
      assert.equal(failed.length, 1);
      assert.equal(failed[0]?.status, 'failed');
      assert.match(failed[0]?.error ?? '', /could not resolve bash/);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('uses POSIX process-group kill before child fallback', async () => {
    let childRef: FakeChild | undefined;
    const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
    const h = await createHarness({
      platform: 'darwin',
      killProcess: (pid, signal) => {
        const call: { pid: number; signal?: NodeJS.Signals | number } = { pid };
        if (signal !== undefined) call.signal = signal;
        killCalls.push(call);
        queueMicrotask(() => {
          childRef?.close(null, typeof signal === 'string' ? signal : null);
        });
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task, child } = await startFakeTask(h);
      await h.registry.stopTask(task, 'user');
      assert.deepEqual(killCalls, [{ pid: -child.pid, signal: 'SIGTERM' }]);
      assert.deepEqual(child.killCalls, []);
      assert.equal(task.status, 'killed');
    } finally {
      await cleanup(h.root);
    }
  });

  void it('falls back to child.kill when process-group kill fails and reports when both fail', async () => {
    const h = await createHarness({
      platform: 'linux',
      killProcess: () => {
        throw new Error('group unavailable');
      },
      childFactory: (pid) =>
        new FakeChild(pid, function (this: FakeChild, signal) {
          queueMicrotask(() => {
            this.close(null, signal ?? null);
          });
          return true;
        }),
    });
    try {
      const { task, child } = await startFakeTask(h, 'Fallback Kill');
      await h.registry.stopTask(task, 'user');
      assert.deepEqual(child.killCalls, ['SIGTERM']);
      assert.equal(task.status, 'killed');
    } finally {
      await cleanup(h.root);
    }

    const failing = await createHarness({
      platform: 'linux',
      killProcess: () => {
        throw new Error('group unavailable');
      },
      childFactory: (pid) =>
        new FakeChild(pid, () => {
          throw new Error('child unavailable');
        }),
    });
    try {
      const { task } = await startFakeTask(failing, 'Failed Kill');
      await assert.rejects(
        () => failing.registry.stopTask(task, 'user'),
        /Could not kill task[\s\S]*group unavailable[\s\S]*child unavailable/,
      );
      assert.equal(task.status, 'running');
    } finally {
      await cleanup(failing.root);
    }
  });

  void it('uses taskkill tree termination on Windows and never falls back to child.kill', async () => {
    let processKillCalled = false;
    let childRef: FakeChild | undefined;
    const killTreeCalls: Array<{ pid: number; phase: WindowsKillPhase }> = [];
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 20,
      stopWaitMs: 500,
      killProcess: () => {
        processKillCalled = true;
        return true;
      },
      killTree: (pid, phase) => {
        killTreeCalls.push({ pid, phase });
        if (phase === 'force') {
          queueMicrotask(() => {
            childRef?.close(null, 'SIGKILL');
          });
        }
        return Promise.resolve(taskkillOutcome(0));
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid, () => {
          throw new Error('root-only kill must not run');
        });
        return childRef;
      },
    });
    try {
      const { task, child } = await startFakeTask(h, 'Windows Kill');
      await h.registry.stopTask(task, 'user');
      assert.equal(processKillCalled, false);
      assert.deepEqual(
        killTreeCalls,
        [
          { pid: child.pid, phase: 'terminate' },
          { pid: child.pid, phase: 'force' },
        ],
      );
      assert.deepEqual(child.killCalls, []);
      const windowsSpawn = h.children[0];
      assert.ok(windowsSpawn, 'Windows shell spawn should be recorded');
      // ComSpec is a full path on a real Windows host, so compare the basename.
      assert.equal(basename(windowsSpawn.shell).toLowerCase(), 'cmd.exe');
      assert.deepEqual(windowsSpawn.args.slice(0, 3), ['/d', '/s', '/c']);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('shares duplicate Windows graceful stops and aborts soft taskkill when force starts', async () => {
    let childRef: FakeChild | undefined;
    let softAbortCount = 0;
    let firstTimer: NodeJS.Timeout | undefined;
    const phases: WindowsKillPhase[] = [];
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 20,
      stopWaitMs: 500,
      killTree: (_pid, phase, signal) => {
        phases.push(phase);
        if (phase === 'terminate') {
          if (signal !== undefined) {
            signal.addEventListener(
              'abort',
              () => {
                softAbortCount += 1;
              },
              { once: true },
            );
          }
          return new Promise<TaskkillOutcome>(() => undefined);
        }
        assert.equal(signal, undefined, 'force taskkill must not reuse the soft abort signal');
        assert.equal(softAbortCount, 1, 'soft attempt should be aborted before force starts');
        queueMicrotask(() => {
          childRef?.close(null, 'SIGKILL');
        });
        return Promise.resolve(taskkillOutcome(0));
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, 'Windows Duplicate Stop');
      const first = h.registry.stopTask(task, 'user');
      firstTimer = task.killEscalationTimer;
      assert.ok(firstTimer, 'first graceful stop should arm an escalation timer');
      const second = h.registry.stopTask(task, 'user');
      const third = h.registry.stopTask(task, 'user');
      assert.equal(task.killEscalationTimer, firstTimer, 'duplicate stops must share one timer');
      await Promise.all([first, second, third]);
      assert.deepEqual(phases, ['terminate', 'force']);
      assert.equal(task.killEscalationTimer, undefined);
      assert.equal(softAbortCount, 1);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('treats explicit Windows force as terminal and does not arm escalation', async () => {
    const phases: WindowsKillPhase[] = [];
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 20,
      killTree: (_pid, phase) => {
        phases.push(phase);
        return Promise.resolve(taskkillOutcome(0));
      },
    });
    try {
      const { task } = await startFakeTask(h, 'Windows Explicit Force');
      requestKillForTest(h.registry, task, 'SIGKILL');
      assert.equal(task.killEscalationTimer, undefined);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.deepEqual(phases, ['force']);
      assert.equal(task.killEscalationTimer, undefined);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('records Windows taskkill exit 128 as an already-exited race', async () => {
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 500,
      stopWaitMs: 1000,
      killTree: () => Promise.resolve(taskkillOutcome(128, 'process not found')),
    });
    try {
      const { task, child } = await startFakeTask(h, 'Windows Missing Process');
      const stopped = h.registry.stopTask(task, 'user');
      await waitFor(
        () => readFileSync(task.outputAbsPath, 'utf8').includes('process not found'),
        'exit 128 notice',
      );
      child.close(0, null);
      await stopped;
      assert.equal(task.status, 'killed');
      assert.match(await readFile(task.outputAbsPath, 'utf8'), /already-exited race/);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('persists a Windows soft failure and still escalates to force after grace', async () => {
    let childRef: FakeChild | undefined;
    const phases: WindowsKillPhase[] = [];
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 20,
      stopWaitMs: 500,
      killTree: (_pid, phase) => {
        phases.push(phase);
        if (phase === 'terminate') return Promise.resolve(taskkillOutcome(1, 'soft denied'));
        queueMicrotask(() => {
          childRef?.close(null, 'SIGKILL');
        });
        return Promise.resolve(taskkillOutcome(0));
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, 'Windows Soft Failure');
      await h.registry.stopTask(task, 'user');
      assert.deepEqual(phases, ['terminate', 'force']);
      assert.match(task.error ?? '', /soft denied/);
      const metadata = parseJsonObject(await readFile(task.metadataAbsPath, 'utf8'), 'metadata');
      assert.match(String(metadata['error']), /soft denied/);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('surfaces Windows force failure loudly without root-only fallback', async () => {
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 20,
      stopWaitMs: 500,
      killTree: (_pid, phase) =>
        Promise.resolve(phase === 'terminate' ? taskkillOutcome(1, 'soft denied') : taskkillOutcome(5, 'force denied')),
      childFactory: (pid) =>
        new FakeChild(pid, () => {
          throw new Error('root-only kill must not run');
        }),
    });
    try {
      const { task, child } = await startFakeTask(h, 'Windows Force Failure');
      await assert.rejects(
        () => h.registry.stopTask(task, 'user'),
        /Windows taskkill \/T \/F force termination failed[\s\S]*Descendant processes may have leaked/,
      );
      assert.equal(task.status, 'running');
      assert.match(task.error ?? '', /force denied/);
      assert.deepEqual(child.killCalls, []);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('keeps terminal metadata running until in-flight Windows force settles', async () => {
    let childRef: FakeChild | undefined;
    let forceStarted = false;
    const force = deferred<TaskkillOutcome>();
    const terminals: BgTaskSnapshot[] = [];
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 20,
      stopWaitMs: 1000,
      publishTerminal: (task) => {
        terminals.push(task);
      },
      killTree: (_pid, phase) => {
        if (phase === 'terminate') return Promise.resolve(taskkillOutcome(0));
        forceStarted = true;
        queueMicrotask(() => {
          childRef?.close(null, 'SIGKILL');
        });
        return force.promise;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, 'Windows Force Barrier');
      const stopped = h.registry.stopTask(task, 'user');
      await waitFor(() => forceStarted, 'force taskkill start');
      await waitFor(() => task.finalized === true, 'child close reached finalization');
      const runningMetadata = parseJsonObject(
        await readFile(task.metadataAbsPath, 'utf8'),
        'metadata before force settles',
      );
      assert.equal(runningMetadata['status'], 'running');
      assert.equal(terminals.length, 0);
      force.resolve(taskkillOutcome(0));
      await stopped;
      assert.equal(task.status, 'killed');
      const terminalMetadata = parseJsonObject(
        await readFile(task.metadataAbsPath, 'utf8'),
        'metadata after force settles',
      );
      assert.equal(terminalMetadata['status'], 'killed');
      assert.equal(terminals.length, 1);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('keeps duplicate stop requests idempotent and escalates to SIGKILL after grace', async () => {
    let childRef: FakeChild | undefined;
    const killCalls: Array<NodeJS.Signals | number | undefined> = [];
    const h = await createHarness({
      platform: 'linux',
      killGraceMs: 20,
      stopWaitMs: 500,
      killProcess: (_pid, signal) => {
        killCalls.push(signal);
        if (signal === 'SIGKILL') {
          queueMicrotask(() => {
            childRef?.close(null, 'SIGKILL');
          });
        }
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, 'Escalate Kill');
      const first = h.registry.stopTask(task, 'user');
      const second = h.registry.stopTask(task, 'user');
      await Promise.all([first, second]);
      assert.deepEqual(killCalls, ['SIGTERM', 'SIGKILL']);
      assert.equal(task.status, 'killed');
      assert.equal(task.killEscalationTimer, undefined, 'escalation timer must be cleared');
    } finally {
      await cleanup(h.root);
    }
  });

  void it('schedules exactly one SIGKILL escalation for concurrent stop requests', async () => {
    // Regression: SIGTERM de-duplication guarded the signal but not the timer,
    // so each concurrent stopTask scheduled its own escalation. When the child
    // outlived the grace window that produced duplicate SIGKILLs.
    const killCalls: Array<NodeJS.Signals | number | undefined> = [];
    const h = await createHarness({
      platform: 'linux',
      killGraceMs: 20,
      stopWaitMs: 120,
      // Never close the child, so every scheduled escalation timer can fire.
      killProcess: (_pid, signal) => {
        killCalls.push(signal);
        return true;
      },
      childFactory: (pid) => new FakeChild(pid),
    });
    try {
      const { task } = await startFakeTask(h, 'Escalate Once');
      await Promise.all([
        h.registry.stopTask(task, 'user').catch(() => undefined),
        h.registry.stopTask(task, 'user').catch(() => undefined),
        h.registry.stopTask(task, 'user').catch(() => undefined),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.deepEqual(
        killCalls,
        ['SIGTERM', 'SIGKILL'],
        'concurrent stop requests must escalate to SIGKILL exactly once',
      );
    } finally {
      await cleanup(h.root);
    }
  });

  void it('finalizes and notifies once under error/close and output-cap races', async () => {
    const h = await createHarness({
      maxOutputBytes: 8,
      killProcess: () => true,
    });
    try {
      const { task, child } = await startFakeTask(h, 'Race Failure');
      child.fail(new Error('spawn exploded'));
      child.close(0, null);
      await waitFor(() => task.status !== 'running', 'spawn race finalization');
      await waitFor(() => h.notifications.length === 1, 'single spawn-race notification');
      assert.equal(task.status, 'failed');
      assert.match(task.error ?? '', /spawn exploded/);
      assert.equal(h.notifications.length, 1);
      // BUG-181: the terminal event itself is authoritative; agents must not poll to reconfirm it.
      const notification = h.notifications[0];
      assert.ok(notification, 'terminal notification should be captured');
      assert.match(
        notification.message.content,
        /<guidance>Terminal state and output metadata are durable\. Do not call bg_status to reconfirm; use bg_logs only if output is needed\.<\/guidance>/,
      );
      assert.deepEqual(notification.options, { deliverAs: 'steer', triggerTurn: true });

      const capped = await h.registry.startTask(h.ctx, 'node noisy.js', {
        name: 'Output Race',
        notifyOnCompletion: true,
        triggerOnCompletion: true,
      });
      const cappedChild = lastSpawn(h).child;
      cappedChild.writeStdout('0123456789abcdef');
      cappedChild.close(1, null);
      cappedChild.close(0, null);
      await waitFor(() => capped.status !== 'running', 'output-cap finalization');
      await waitFor(() => h.notifications.length === 2, 'single output-cap notification');
      assert.equal(capped.status, 'failed');
      assert.match(capped.error ?? '', /Output exceeded cap/);
      assert.equal(h.notifications.length, 2);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('publishes terminal snapshots exactly once after durable metadata', async () => {
    const terminals: BgTaskSnapshot[] = [];
    const metadataStatuses: unknown[] = [];
    let metadataPath = '';
    const h = await createHarness({
      publishTerminal: (task) => {
        terminals.push(task);
        metadataStatuses.push(
          parseJsonObject(readFileSync(metadataPath, 'utf8'), 'terminal metadata must be written')[
            'status'
          ],
        );
      },
    });
    try {
      const { task, child } = await startFakeTask(h, 'Terminal Once');
      metadataPath = task.metadataAbsPath;
      child.close(0, null);
      child.close(1, null);
      await waitFor(() => task.status !== 'running', 'terminal status');
      await waitFor(() => terminals.length === 1, 'single terminal publication');
      const terminal = terminals[0];
      assert.ok(terminal, 'terminal snapshot should be present');
      assert.equal(terminal.id, task.id);
      assert.equal(terminal.status, 'completed');
      assert.deepEqual(metadataStatuses, ['completed']);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('keeps failed terminal EventBus delivery loud and retriable', async () => {
    const terminals: BgTaskSnapshot[] = [];
    let attempts = 0;
    const h = await createHarness({
      publishTerminal: (task) => {
        attempts += 1;
        if (attempts === 1) throw new Error('terminal bus unavailable');
        terminals.push(task);
      },
    });
    try {
      const { task, child } = await startFakeTask(h, 'Terminal Retry');
      child.close(0, null);
      await waitFor(() => task.status === 'completed', 'terminal retry completion');
      await waitFor(() => terminals.length === 1, 'terminal retry publication');
      assert.equal(attempts, 2);
      assert.equal(task.terminalPublished, true);
      assert.equal(terminals[0]?.id, task.id);
      assert.match(
        h.errors.flat().join(' '),
        /terminal publication failed|terminal bus unavailable/,
      );
    } finally {
      await cleanup(h.root);
    }
  });

  void it('resets notified when completion notification delivery fails and records loud metadata errors', async () => {
    const failingNotify = await createHarness({
      sendCompletionNotification: () => {
        throw new Error('send failed');
      },
    });
    try {
      const { task, child } = await startFakeTask(failingNotify, 'Notify Failure');
      child.close(0, null);
      await waitFor(() => task.status === 'completed', 'notification failure task completion');
      await waitFor(() => failingNotify.errors.length > 0, 'notification failure log');
      assert.equal(task.notified, false);
      const metadata = parseJsonObject(
        await readFile(task.metadataAbsPath, 'utf8'),
        'notification metadata must be an object',
      );
      assert.equal(metadata['notified'], false);
      assert.match(failingNotify.errors.flat().join(' '), /notification failed|send failed/);
    } finally {
      await cleanup(failingNotify.root);
    }

    const metadataFailure = await createHarness();
    try {
      const { task, child } = await startFakeTask(metadataFailure, 'Metadata Failure');
      await rm(dirname(task.outputAbsPath), { recursive: true, force: true });
      child.close(0, null);
      await waitFor(() => task.status === 'failed', 'metadata failure task completion');
      await waitFor(
        () => metadataFailure.notifications.length === 1,
        'notification despite metadata failure',
      );
      await waitFor(() => metadataFailure.errors.length > 0, 'metadata failure log');
      assert.equal(task.notified, true);
      assert.match(task.error ?? '', /Terminal metadata write failed/);
      assert.match(
        metadataFailure.errors.flat().join(' '),
        /failed to (write failed terminal|write|update )?metadata|ENOENT/,
      );
    } finally {
      await cleanup(metadataFailure.root);
    }
  });

  void it('prunes oldest finished tasks while preserving running tasks', async () => {
    let clock = 1_000;
    const h = await createHarness({
      maxRecentTasks: 3,
      now: () => clock++,
    });
    try {
      const running = await h.registry.startTask(h.ctx, 'sleep forever', {
        name: 'Still Running',
        notifyOnCompletion: false,
      });
      assert.equal(running.status, 'running');

      for (let i = 1; i <= 4; i++) {
        const suffix = String(i);
        const task = await h.registry.startTask(h.ctx, `printf ${suffix}`, {
          name: `Finished ${suffix}`,
          notifyOnCompletion: false,
        });
        lastSpawn(h).child.close(0, null);
        await waitFor(() => task.status === 'completed', `finished ${suffix}`);
      }

      await waitFor(() => h.registry.allTasks().length <= 3, 'old finished tasks pruned');
      const names = h.registry
        .allTasks()
        .map((task) => task.name)
        .sort();
      assert.deepEqual(names, ['Finished 3', 'Finished 4', 'Still Running'].sort());
    } finally {
      await cleanup(h.root);
    }
  });

  void it('fails timed-out shell tasks', async () => {
    const h = await createHarness({
      platform: 'linux',
      killProcess: (_pid, signal) => {
        queueMicrotask(() => lastSpawn(h).child.close(null, typeof signal === 'string' ? signal : null));
        return true;
      },
    });
    try {
      const task = await h.registry.startTask(h.ctx, 'sleep forever', {
        name: 'Timed shell',
        timeoutSeconds: 0.02,
        notifyOnCompletion: false,
      });
      await waitFor(() => task.status === 'failed', 'timeout failure');
      assert.match(task.error ?? '', /Timed out/);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('caps output and preserves the bounded prefix', async () => {
    let childRef: FakeChild | undefined;
    const h = await createHarness({
      platform: 'linux',
      maxOutputBytes: 5,
      killProcess: (_pid, signal) => {
        queueMicrotask(() => childRef?.close(null, typeof signal === 'string' ? signal : null));
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task, child } = await startFakeTask(h, 'Noisy shell');
      child.writeStdout('123456789');
      await waitFor(() => task.status === 'failed', 'output cap failure');
      assert.match(task.error ?? '', /Output exceeded cap/);
      assert.match((await h.registry.getTaskLogs(task, 100, false)).text, /^12345/);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('rejects empty commands, unknown ids, and startup during shutdown', async () => {
    const h = await createHarness();
    try {
      await assert.rejects(() => h.registry.startTask(h.ctx, '   '), /background command is empty/i);
      await h.registry.startTask(h.ctx, 'first', { notifyOnCompletion: false });
      h.registry.setShuttingDown(true);
      await assert.rejects(() => h.registry.startTask(h.ctx, 'second'), /shutting down/);
      assert.throws(() => h.registry.resolveTask('missing'), /Unknown background task ID/);
    } finally {
      await cleanup(h.root);
    }
  });

});
