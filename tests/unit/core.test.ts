import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'node:test';
import {
  boundedRead,
  deriveCompletionDeliveryGuidance,
  deriveTaskNameFromCommand,
  formatSnapshotList,
  normalizeMaxBytes,
  normalizeTaskName,
  parseBgCommandArgs,
  sanitizePathSegment,
  shellInvocation,
  snapshot,
  taskDisplayName,
  truncateChars,
  type BgTask,
} from '../../src/core/common.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function task(overrides: Partial<BgTask> = {}): BgTask {
  return {
    id: 'b1234',
    name: 'Tests',
    command: 'npm test',
    status: 'running',
    outputPath: '/tmp/b1234.output',
    outputAbsPath: '/tmp/b1234.output',
    metadataAbsPath: '/tmp/b1234.json',
    cwd: '/tmp/project',
    startTime: 10,
    bytesWritten: 0,
    notified: false,
    notifyOnCompletion: true,
    triggerOnCompletion: true,
    waiters: [],
    ...overrides,
  };
}

void describe('shell task core', () => {
  void it('parses /bg names without an agent mode', () => {
    assert.deepEqual(parseBgCommandArgs('echo ok'), { command: 'echo ok' });
    assert.deepEqual(parseBgCommandArgs('--name "Unit Tests" npm test'), {
      name: 'Unit Tests',
      command: 'npm test',
    });
    assert.deepEqual(parseBgCommandArgs('-n=Lint npm run lint'), {
      name: 'Lint',
      command: 'npm run lint',
    });
    assert.deepEqual(parseBgCommandArgs(''), { command: '' });
    assert.throws(() => parseBgCommandArgs('--name'), /requires a task name/);
    assert.deepEqual(parseBgCommandArgs('--agent npm test'), { command: '--agent npm test' });
  });

  void it('normalizes task names and command-derived fallbacks', () => {
    assert.equal(normalizeTaskName('  "My   task"  '), 'My task');
    assert.equal(normalizeTaskName('   '), undefined);
    assert.equal(deriveTaskNameFromCommand('npm run test:unit -- --watch'), 'npm run test:unit');
    assert.equal(taskDisplayName({ description: 'Fallback', command: 'echo ignored' }), 'Fallback');
    assert.equal(truncateChars('abcdef', 4), 'abc…');
    assert.equal(sanitizePathSegment('session / unsafe'), 'session-unsafe');
  });

  void it('reports completion delivery settings truthfully', () => {
    assert.match(deriveCompletionDeliveryGuidance(true, true).text, /notification: enabled/i);
    assert.match(deriveCompletionDeliveryGuidance(true, true).text, /steering delivery: enabled/i);
    assert.match(deriveCompletionDeliveryGuidance(true, true).text, /idle wake-up: enabled/i);
    assert.match(deriveCompletionDeliveryGuidance(true, false).text, /idle wake-up: disabled/i);
    const disabled = deriveCompletionDeliveryGuidance(false, true).text;
    assert.match(disabled, /notification: disabled/i);
    assert.match(disabled, /steering delivery: disabled/i);
    assert.match(disabled, /idle wake-up: disabled/i);
  });

  void it('creates shell-only snapshots and readable task lists', () => {
    const finished = snapshot(
      task({
        status: 'completed',
        endTime: 20,
        exitCode: 0,
        bytesWritten: 5,
      }),
    );
    assert.equal(Object.hasOwn(finished, 'isAgent'), false);
    assert.equal(Object.hasOwn(finished, 'model'), false);
    assert.equal(Object.hasOwn(finished, 'tokenUsage'), false);
    assert.match(formatSnapshotList([finished]), /completed.*Tests/s);
    assert.match(formatSnapshotList([]), /No background tasks/);
  });

  void it('bounds head and tail log reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-bg-core-'));
    roots.push(root);
    const path = join(root, 'task.output');
    await writeFile(path, '0123456789', 'utf8');
    const head = await boundedRead(path, 4, false);
    const tail = await boundedRead(path, 4, true);
    assert.deepEqual(
      { content: head.content, bytesRead: head.bytesRead, totalBytes: head.totalBytes, truncated: head.truncated },
      { content: '0123', bytesRead: 4, totalBytes: 10, truncated: true },
    );
    assert.equal(tail.content, '6789');
    assert.equal(normalizeMaxBytes(undefined, 12), 12);
    assert.equal(normalizeMaxBytes(-1, 12), 1);
  });

  void it('selects the configured Pi shell', () => {
    assert.deepEqual(shellInvocation('echo ok', 'linux', {}), {
      shell: '/bin/sh',
      args: ['-c', 'echo ok'],
      dialect: 'posix',
      windowsVerbatimArguments: false,
    });
    const configured = shellInvocation('echo ok', 'linux', {}, {
      shell: '/bin/bash',
      args: ['--noprofile', '-c'],
    });
    assert.deepEqual(configured, {
      shell: '/bin/bash',
      args: ['--noprofile', '-c', 'echo ok'],
      dialect: 'posix',
      windowsVerbatimArguments: false,
    });
  });
});
