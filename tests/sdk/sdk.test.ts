import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'node:test';
import {
  ModelRuntime,
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type EventBus,
  type ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import { parseJsonText, type BgTaskSnapshot } from '../../src/core/common.js';
import {
  BG_REQUEST_CHANNEL,
  BG_REQUEST_SCHEMA,
  BG_RESPONSE_CHANNEL,
  BG_TERMINAL_CHANNEL,
  BG_TERMINAL_SCHEMA,
} from '../../src/core/extension-api.js';

const extensionPath = resolve('extensions/background-tasks.ts');
const roots: string[] = [];

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTaskSnapshot(value: unknown): value is BgTaskSnapshot {
  if (!isRecord(value)) return false;
  const status = value['status'];
  return (
    typeof value['id'] === 'string' &&
    typeof value['command'] === 'string' &&
    (status === 'running' || status === 'completed' || status === 'failed' || status === 'killed') &&
    typeof value['outputPath'] === 'string' &&
    typeof value['cwd'] === 'string' &&
    typeof value['startTime'] === 'number' &&
    typeof value['bytesWritten'] === 'number' &&
    typeof value['notified'] === 'boolean' &&
    typeof value['notifyOnCompletion'] === 'boolean' &&
    typeof value['triggerOnCompletion'] === 'boolean'
  );
}

function task(value: unknown): BgTaskSnapshot {
  assert.ok(isTaskSnapshot(value), 'tool result must contain a shell task snapshot');
  assert.equal(Object.hasOwn(value, 'isAgent'), false, 'shell task snapshots must not expose isAgent');
  return value;
}

function resultObject(value: unknown): JsonObject {
  assert.ok(isRecord(value));
  return value;
}

async function harness(eventBus?: EventBus) {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-sdk-'));
  roots.push(root);
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [extensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
    ...(eventBus ? { eventBus } : {}),
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    modelRuntime,
    noTools: 'builtin',
  });
  await session.extensionRunner.emit({ type: 'session_start', reason: 'startup' });
  return { session, cwd, agentDir };
}

async function dispose(session: AgentSession): Promise<void> {
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
}

async function execute(session: AgentSession, name: string, params: unknown): Promise<JsonObject> {
  const tool = session.getToolDefinition(name);
  assert.ok(tool, `missing tool ${name}`);
  const result: unknown = await tool.execute(
    `call-${name}`,
    params,
    undefined,
    undefined,
    session.extensionRunner.createContext(),
  );
  return resultObject(result);
}

function details(result: JsonObject): JsonObject {
  return resultObject(result['details']);
}

function resultTask(result: JsonObject): BgTaskSnapshot {
  return task(details(result)['task']);
}

function resultTasks(result: JsonObject): BgTaskSnapshot[] {
  const tasks = details(result)['tasks'];
  assert.ok(Array.isArray(tasks), 'tool result must contain a task list');
  return tasks.map(task);
}

function resultText(result: JsonObject): string {
  const content = result['content'];
  assert.ok(Array.isArray(content));
  const first: unknown = content[0];
  assert.ok(isRecord(first));
  const text = first['text'];
  if (typeof text !== 'string') assert.fail('tool result text must be a string');
  return text;
}

async function waitForTask(session: AgentSession, id: string): Promise<BgTaskSnapshot> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const status = await execute(session, 'bg_status', { taskId: id });
    const tasks = details(status)['tasks'];
    assert.ok(Array.isArray(tasks));
    const current = task(tasks[0]);
    if (current.status !== 'running') return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${id}`);
}

async function script(cwd: string, name: string, body: string): Promise<string> {
  const path = `${name}.cjs`;
  await writeFile(join(cwd, path), body, 'utf8');
  return `node ${path}`;
}

function customNotifications(session: AgentSession): JsonObject[] {
  const entries: unknown[] = [...session.sessionManager.getEntries()];
  return entries.filter(
    (entry): entry is JsonObject =>
      isRecord(entry) &&
      entry['type'] === 'custom_message' &&
      entry['customType'] === 'background-task-notification',
  );
}

function waitForResponse(eventBus: EventBus, requestId: string): Promise<JsonObject> {
  return new Promise((resolveResponse, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for EventBus response ${requestId}`));
    }, 5_000);
    const unsubscribe = eventBus.on(BG_RESPONSE_CHANNEL, (value) => {
      if (!isRecord(value) || value['request_id'] !== requestId) return;
      clearTimeout(timer);
      unsubscribe();
      resolveResponse(value);
    });
  });
}

async function request(
  eventBus: EventBus,
  requestId: string,
  operation: string,
  payload: JsonObject,
): Promise<JsonObject> {
  const response = waitForResponse(eventBus, requestId);
  eventBus.emit(BG_REQUEST_CHANNEL, {
    schema_version: BG_REQUEST_SCHEMA,
    request_id: requestId,
    operation,
    payload,
  });
  return response;
}

function stripSgr(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function statusUi(base: ExtensionUIContext, statuses: Array<string | undefined>): ExtensionUIContext {
  return {
    ...base,
    notify: () => undefined,
    setStatus: (_key, text) => statuses.push(text),
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

void describe('shell-task SDK integration', { concurrency: false }, () => {
  void it('starts Pi without crashing and exposes only shell-task surfaces', async () => {
    const { session } = await harness();
    try {
      assert.deepEqual(
        session.getActiveToolNames().filter((name) => name.startsWith('bg_')).sort(),
        ['bg_kill', 'bg_logs', 'bg_run', 'bg_status'],
      );
      const commands = session.extensionRunner
        .getRegisteredCommands()
        .map((command) => command.invocationName);
      for (const name of ['bg', 'jobs', 'logs', 'kill', 'tasks', 'bg-tasks', 'bg-clear'])
        assert.ok(commands.includes(name), `missing /${name}`);
      for (const removed of ['bg-update', 'fusion', 'fusion-models'])
        assert.ok(!commands.includes(removed), `removed /${removed} is still registered`);
      for (const removed of ['bg_run_pi_attested', 'fusion_brainstorm'])
        assert.equal(session.getToolDefinition(removed), undefined);

      const run = session.getToolDefinition('bg_run');
      assert.ok(run);
      const runSchema = JSON.stringify(run.parameters);
      assert.doesNotMatch(runSchema, /isAgent|telemetry|attest/i);
      assert.doesNotMatch(runSchema, /"agent"\s*:/i);
    } finally {
      await dispose(session);
    }
  });

  void it('runs a shell command, persists metadata, and reads bounded logs', async () => {
    const { session, cwd } = await harness();
    try {
      const command = await script(cwd, 'echo', "process.stdout.write('sdk-shell-ok\\n');\n");
      const started = await execute(session, 'bg_run', {
        name: 'SDK shell',
        command,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      const finished = await waitForTask(session, resultTask(started).id);
      assert.equal(finished.status, 'completed');
      assert.equal(finished.name, 'SDK shell');
      assert.ok(existsSync(finished.outputPath));
      const metadataPath = finished.outputPath.replace(/\.output$/, '.json');
      const metadata = resultObject(parseJsonText(await readFile(metadataPath, 'utf8')));
      assert.equal(metadata['status'], 'completed');
      assert.equal(metadata['name'], 'SDK shell');
      assert.equal(Object.hasOwn(metadata, 'isAgent'), false);

      const logs = await execute(session, 'bg_logs', { taskId: finished.id, maxBytes: 100 });
      assert.match(resultText(logs), /sdk-shell-ok/);
      await assert.rejects(() => execute(session, 'bg_kill', { taskId: finished.id }), /not running/);
    } finally {
      await dispose(session);
    }
  });

  void it('keeps shell completion notification and trigger controls', async () => {
    const { session, cwd } = await harness();
    try {
      const command = await script(cwd, 'notify', "setTimeout(() => {}, 30);\n");
      const notified = await execute(session, 'bg_run', {
        name: 'Notify shell',
        command,
        notifyOnCompletion: true,
        triggerOnCompletion: false,
      });
      const notifiedTask = await waitForTask(session, resultTask(notified).id);
      assert.equal(notifiedTask.status, 'completed');
      assert.equal(notifiedTask.triggerOnCompletion, false);
      assert.equal(customNotifications(session).length, 1);

      const quiet = await execute(session, 'bg_run', {
        name: 'Quiet shell',
        command,
        notifyOnCompletion: false,
        triggerOnCompletion: true,
      });
      await waitForTask(session, resultTask(quiet).id);
      assert.equal(customNotifications(session).length, 1);
    } finally {
      await dispose(session);
    }
  });

  void it('kills running shell commands and enforces timeouts', async () => {
    const { session, cwd } = await harness();
    try {
      const longCommand = await script(cwd, 'long', 'setTimeout(() => {}, 30_000);\n');
      const running = await execute(session, 'bg_run', {
        name: 'Kill shell',
        command: longCommand,
        notifyOnCompletion: false,
      });
      const killed = resultTask(
        await execute(session, 'bg_kill', { taskId: resultTask(running).id }),
      );
      assert.equal(killed.status, 'killed');

      const timeout = await execute(session, 'bg_run', {
        name: 'Timeout shell',
        command: longCommand,
        timeoutSeconds: 0.05,
        notifyOnCompletion: false,
      });
      const timedOut = await waitForTask(session, resultTask(timeout).id);
      assert.equal(timedOut.status, 'failed');
      assert.match(timedOut.error ?? '', /Timed out/);
    } finally {
      await dispose(session);
    }
  });

  void it('ignores the EventBus v1 isAgent flag and runs an ordinary shell task', async () => {
    const eventBus = createEventBus();
    const { session, cwd } = await harness(eventBus);
    try {
      const capabilities = await request(eventBus, 'caps', 'capabilities', {});
      assert.equal(capabilities['ok'], true);
      const capResult = resultObject(capabilities['result']);
      assert.equal(Object.hasOwn(capResult, 'run_is_agent'), false);
      assert.equal(capResult['run'], true);

      const command = await script(cwd, 'event', "process.stdout.write('event-shell-ok\\n');\n");
      const response = await request(eventBus, 'run', 'run', {
        name: 'Event shell',
        command,
        isAgent: true,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
      });
      assert.equal(response['ok'], true, String(response['error'] ?? ''));
      const started = task(response['result']);
      assert.equal(Object.hasOwn(started, 'isAgent'), false);
      const finished = await waitForTask(session, started.id);
      assert.equal(finished.status, 'completed');
      assert.equal(Object.hasOwn(finished, 'isAgent'), false);
      const logs = await execute(session, 'bg_logs', { taskId: finished.id, maxBytes: 100 });
      assert.match(resultText(logs), /event-shell-ok/);
    } finally {
      await dispose(session);
    }
  });

  void it('keeps the event-driven prompt contract and truthful launch receipts', async () => {
    const { session, cwd } = await harness();
    try {
      const prompt = session.extensionRunner.createContext().getSystemPrompt();
      assert.match(prompt, /Do not call sleep, bg_status, or bg_logs merely to wait/);
      assert.match(prompt, /automatically starts a follow-up agent turn/);
      assert.match(prompt, /Treat <background-task-notification> as durable terminal truth/);
      assert.doesNotMatch(prompt, /After bg_run, use bg_status and bg_logs to inspect progress/);

      const run = session.getToolDefinition('bg_run');
      const status = session.getToolDefinition('bg_status');
      const logs = session.getToolDefinition('bg_logs');
      assert.ok(run && status && logs);
      assert.match(run.description, /do not sleep or poll merely to wait/);
      assert.match(status.description, /not a waiting primitive/);
      assert.match(logs.description, /not a waiting primitive/);

      const command = await script(cwd, 'receipt', 'setTimeout(() => {}, 30_000);\n');
      const cases = [
        [{}, true, true, /Automatic follow-up turn: enabled/],
        [{ notifyOnCompletion: true, triggerOnCompletion: false }, true, false, /will not start an agent turn/],
        [{ notifyOnCompletion: false, triggerOnCompletion: true }, false, true, /triggerOnCompletion has no effect/],
        [{ notifyOnCompletion: false, triggerOnCompletion: false }, false, false, /deliberate manual monitoring/],
      ] as const;
      for (const [delivery, expectedNotify, expectedTrigger, receipt] of cases) {
        const result = await execute(session, 'bg_run', {
          name: 'Delivery receipt',
          command,
          ...delivery,
        });
        const launched = resultTask(result);
        assert.equal(launched.notifyOnCompletion, expectedNotify);
        assert.equal(launched.triggerOnCompletion, expectedTrigger);
        assert.match(resultText(result), receipt);
        assert.equal(result['terminate'], undefined);
      }
    } finally {
      await dispose(session);
    }
  });

  void it('supports list/prefix status and bounded head/tail logs with loud ID errors', async () => {
    const { session, cwd } = await harness();
    try {
      const firstCommand = await script(cwd, 'first', 'process.stdout.write("abcdef");\n');
      const secondCommand = await script(cwd, 'second', 'process.stdout.write("123456");\n');
      const first = await execute(session, 'bg_run', {
        name: 'SDK First', command: firstCommand, notifyOnCompletion: false,
      });
      const second = await execute(session, 'bg_run', {
        name: 'SDK Second', command: secondCommand, notifyOnCompletion: false,
      });
      const firstDone = await waitForTask(session, resultTask(first).id);
      await waitForTask(session, resultTask(second).id);
      assert.ok(resultTasks(await execute(session, 'bg_status', {})).length >= 2);
      assert.equal(
        resultTasks(await execute(session, 'bg_status', { taskId: firstDone.id.slice(0, 5) }))[0]?.id,
        firstDone.id,
      );
      await assert.rejects(() => execute(session, 'bg_status', { taskId: 'b' }), /Ambiguous/);
      await assert.rejects(
        () => execute(session, 'bg_status', { taskId: 'bdeadbeef' }),
        /Unknown background task ID/,
      );
      const head = await execute(session, 'bg_logs', {
        taskId: firstDone.id, maxBytes: 3, tail: false,
      });
      assert.match(resultText(head), /^abc/);
      assert.match(resultText(head), /Showing head/);
      const tail = await execute(session, 'bg_logs', {
        taskId: firstDone.id, maxBytes: 3, tail: true,
      });
      assert.match(resultText(tail), /def/);
      assert.match(resultText(tail), /Showing tail/);
      await assert.rejects(
        () => execute(session, 'bg_logs', { taskId: 'bdeadbeef' }),
        /Unknown background task ID/,
      );
    } finally {
      await dispose(session);
    }
  });

  void it('serves EventBus logs/status/kill/errors and emits one terminal event', async () => {
    const eventBus = createEventBus();
    const terminals: BgTaskSnapshot[] = [];
    const unsubscribe = eventBus.on(BG_TERMINAL_CHANNEL, (value) => {
      assert.ok(isRecord(value));
      assert.equal(value['schema_version'], BG_TERMINAL_SCHEMA);
      terminals.push(task(value['task']));
    });
    const { session, cwd } = await harness(eventBus);
    try {
      const echoCommand = await script(cwd, 'bus-echo', "process.stdout.write('api-ok\\n');\n");
      const run = await request(eventBus, 'bus-run', 'run', {
        name: 'Bus echo', command: echoCommand,
        notifyOnCompletion: false, triggerOnCompletion: false,
      });
      assert.equal(run['ok'], true, String(run['error'] ?? 'EventBus run failed'));
      const echo = task(run['result']);
      await waitForTask(session, echo.id);
      for (let attempt = 0; attempt < 40 && !terminals.some((entry) => entry.id === echo.id); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(terminals.filter((entry) => entry.id === echo.id).length, 1);

      const logs = await request(eventBus, 'bus-logs', 'logs', {
        taskId: echo.id, maxBytes: 100, tail: true,
      });
      assert.match(String(resultObject(logs['result'])['text']), /api-ok/);
      const status = await request(eventBus, 'bus-status', 'status', { taskId: echo.id });
      const statusTasks = resultObject(status['result'])['tasks'];
      assert.ok(Array.isArray(statusTasks));
      assert.equal(task(statusTasks[0]).status, 'completed');

      const longCommand = await script(cwd, 'bus-long', 'setTimeout(() => {}, 30_000);\n');
      const longRun = await request(eventBus, 'bus-long-run', 'run', {
        name: 'Bus long', command: longCommand,
        notifyOnCompletion: false, triggerOnCompletion: false,
      });
      const longTask = task(longRun['result']);
      const killed = await request(eventBus, 'bus-kill', 'kill', { taskId: longTask.id });
      assert.equal(task(resultObject(killed['result'])['task']).status, 'killed');

      const malformed = await request(eventBus, 'bus-bad', 'run', {
        name: 'Bad bus run', command: 'echo no', timeoutSeconds: null,
        notifyOnCompletion: false, triggerOnCompletion: false,
      });
      assert.equal(malformed['ok'], false);
      assert.match(String(malformed['error']), /positive integer/);
      assert.equal((await request(eventBus, 'bus-unknown', 'mystery', {}))['ok'], false);
      assert.equal((await request(eventBus, 'bus-dup', 'capabilities', {}))['ok'], true);
      const duplicate = await request(eventBus, 'bus-dup', 'capabilities', {});
      assert.equal(duplicate['ok'], false);
      assert.match(String(duplicate['error']), /duplicate request_id/);
    } finally {
      unsubscribe();
      await dispose(session);
    }
  });

  void it('keeps finished footer counts until bg-clear and preserves running counts', async () => {
    const { session, cwd } = await harness();
    const statuses: Array<string | undefined> = [];
    session.extensionRunner.setUIContext(
      statusUi(session.extensionRunner.getUIContext(), statuses),
    );
    try {
      const doneCommand = await script(cwd, 'footer-done', "process.stdout.write('done\\n');\n");
      const done = await execute(session, 'bg_run', {
        name: 'Footer done', command: doneCommand, notifyOnCompletion: false,
      });
      await waitForTask(session, resultTask(done).id);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.match(stripSgr(statuses.at(-1) ?? ''), /bg 1✓/);

      const clear = session.extensionRunner.getRegisteredCommands()
        .find((command) => command.invocationName === 'bg-clear');
      assert.ok(clear);
      await clear.handler('', session.extensionRunner.createCommandContext());
      assert.equal(statuses.at(-1), undefined);

      const longCommand = await script(cwd, 'footer-long', 'setTimeout(() => {}, 30_000);\n');
      const running = await execute(session, 'bg_run', {
        name: 'Footer running', command: longCommand, notifyOnCompletion: false,
      });
      const doneTwo = await execute(session, 'bg_run', {
        name: 'Footer done two', command: doneCommand, notifyOnCompletion: false,
      });
      await waitForTask(session, resultTask(doneTwo).id);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.match(stripSgr(statuses.at(-1) ?? ''), /bg 1▶ 1✓/);
      await clear.handler('', session.extensionRunner.createCommandContext());
      assert.equal(stripSgr(statuses.at(-1) ?? ''), 'bg 1▶');
      await execute(session, 'bg_kill', { taskId: resultTask(running).id });
    } finally {
      await dispose(session);
    }
  });

  void it('prepares legacy unnamed shell calls without restoring agent fields', async () => {
    const { session } = await harness();
    try {
      const run = session.getToolDefinition('bg_run');
      assert.ok(run?.prepareArguments);
      const prepared: unknown = run.prepareArguments({ command: 'npm run qa', description: 'Legacy QA' });
      assert.ok(isRecord(prepared));
      assert.equal(prepared['name'], 'Legacy QA');
      assert.equal(prepared['command'], 'npm run qa');
      assert.equal(Object.hasOwn(prepared, 'isAgent'), false);
      assert.throws(() => run.prepareArguments?.(null), /arguments must be an object/);
      await assert.rejects(
        () => execute(session, 'bg_run', { name: 'Empty shell', command: '' }),
        /Background command is empty/,
      );
    } finally {
      await dispose(session);
    }
  });

  void it('records configured-shell spawn failures and kills all tasks on shutdown', async () => {
    const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
    const { session, cwd, agentDir } = await harness();
    let shutDown = false;
    try {
      const badShell = join(agentDir, 'not-executable-shell');
      await writeFile(badShell, '#!/bin/sh\n', 'utf8');
      await chmod(badShell, 0o600);
      await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ shellPath: badShell }));
      process.env['PI_CODING_AGENT_DIR'] = agentDir;
      const failed = await execute(session, 'bg_run', {
        name: 'Bad shell', command: 'echo no', notifyOnCompletion: false,
      });
      const failedTask = await waitForTask(session, resultTask(failed).id);
      assert.equal(failedTask.status, 'failed');
      assert.match(failedTask.error ?? '', /EACCES|permission denied/i);
      const metadata = resultObject(parseJsonText(
        await readFile(failedTask.outputPath.replace(/\.output$/, '.json'), 'utf8'),
      ));
      assert.equal(metadata['status'], 'failed');

      Reflect.deleteProperty(process.env, 'PI_CODING_AGENT_DIR');
      const command = await script(cwd, 'shutdown', 'setTimeout(() => {}, 30_000);\n');
      const one = await execute(session, 'bg_run', {
        name: 'Shutdown one', command, notifyOnCompletion: false,
      });
      const two = await execute(session, 'bg_run', {
        name: 'Shutdown two', command, notifyOnCompletion: false,
      });
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      shutDown = true;
      assert.equal(resultTasks(await execute(session, 'bg_status', { taskId: resultTask(one).id }))[0]?.status, 'killed');
      assert.equal(resultTasks(await execute(session, 'bg_status', { taskId: resultTask(two).id }))[0]?.status, 'killed');
    } finally {
      if (previousAgentDir === undefined) Reflect.deleteProperty(process.env, 'PI_CODING_AGENT_DIR');
      else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
      if (!shutDown) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
  });
});
