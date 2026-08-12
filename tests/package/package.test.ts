import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parseJsonText } from '../../src/core/common.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function text(path: string): Promise<string> {
  return readFile(join(root, path), 'utf8');
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}

void describe('package surface', () => {
  void it('ships one shell-task extension with the required peer dependencies', async () => {
    const manifest = record(parseJsonText(await text('package.json')), 'package manifest');
    const pi = record(manifest['pi'], 'pi manifest');
    assert.deepEqual(pi['extensions'], ['./extensions/background-tasks.ts']);

    const peers = record(manifest['peerDependencies'], 'peer dependencies');
    for (const name of [
      '@earendil-works/pi-coding-agent',
      '@earendil-works/pi-tui',
      'typebox',
    ]) {
      assert.equal(typeof peers[name], 'string', `missing peer ${name}`);
    }

    const description = String(manifest['description']);
    assert.match(description, /background shell tasks/i);
    assert.doesNotMatch(description, /fusion|agent spawning|attest/i);
  });

  void it('keeps the documented shell-task commands and tools', async () => {
    const readme = await text('README.md');
    for (const surface of [
      '/bg ',
      '/jobs',
      '/logs',
      '/kill',
      '/tasks',
      '/bg-clear',
      'bg_run',
      'bg_status',
      'bg_logs',
      'bg_kill',
      'notifyOnCompletion',
      'triggerOnCompletion',
    ]) {
      assert.match(readme, new RegExp(surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  void it('does not document or register removed update and agent features', async () => {
    const readme = await text('README.md');
    const extension = await text('src/extension.ts');
    const combined = `${readme}\n${extension}`;
    for (const removed of [
      '/bg-update',
      '/fusion',
      'fusion_brainstorm',
      'bg_run_pi_attested',
      '--agent',
      'PI_BG_DISABLE_UPDATE_CHECK',
      'PI_BG_REGISTRY_URL',
      'PI_BG_DISABLE_PI_TELEMETRY',
    ]) {
      assert.doesNotMatch(combined, new RegExp(removed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  void it('limits legacy isAgent compatibility to the EventBus v1 parser', async () => {
    const readme = await text('README.md');
    assert.match(readme, /does not restore or reattach tasks from an old runtime directory/i);

    const compatibilityApi = await text('src/core/extension-api.ts');
    assert.match(compatibilityApi, /API v1 required this field/);
    assert.match(compatibilityApi, /requireBoolean\(payload\['isAgent'\], 'run\.payload\.isAgent'\)/);

    for (const path of [
      'src/core/common.ts',
      'src/core/registry.ts',
      'src/extension.ts',
      'src/ui/background-tasks-manager.ts',
    ]) {
      assert.doesNotMatch(await text(path), /isAgent/, `${path} must omit the legacy flag`);
    }
  });

  void it('contains the shell runtime and omits removed source modules', async () => {
    for (const path of [
      'extensions/background-tasks.ts',
      'src/extension.ts',
      'src/core/common.ts',
      'src/core/registry.ts',
      'src/core/extension-api.ts',
      'src/core/durable-fs.ts',
      'src/core/windows-taskkill.ts',
      'src/ui/background-tasks-manager.ts',
    ]) {
      await access(join(root, path));
    }

    const sourceEntries = await readdir(join(root, 'src'));
    assert.ok(!sourceEntries.includes('fusion-extension.ts'));
    assert.ok(!sourceEntries.includes('fusion-child-extension.ts'));
    for (const removed of [
      'src/core/fusion',
      'src/core/attested-pi-run.ts',
      'src/core/pi-launch.ts',
      'src/core/update-check.ts',
      'src/ui/fusion-model-selector.ts',
      'extensions/fusion-child.ts',
    ]) {
      await assert.rejects(access(join(root, removed)));
    }
  });

  void it('registers only the remaining public command and tool names in source', async () => {
    const extension = await text('src/extension.ts');
    for (const command of ['bg', 'jobs', 'logs', 'kill', 'tasks', 'bg-tasks', 'bg-clear']) {
      assert.match(extension, new RegExp(`registerCommand\\('${command}'`));
    }
    for (const tool of ['bg_run', 'bg_status', 'bg_logs', 'bg_kill']) {
      assert.match(extension, new RegExp(`name: '${tool}'`));
    }
  });
});
