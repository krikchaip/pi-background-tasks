import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { Compile } from 'typebox/compile';
import { parseJsonText } from '../../src/core/common.js';

// `URL.pathname` yields `/D:/...` on Windows, which then joins into `D:\D:\...`.
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

/** TypeBox APIs removed in the 1.3.x line bundled by current Pi releases. */
const REMOVED_TYPEBOX_APIS = [
  'Type.Base',
  'Type.Awaited',
  'Type.Promise',
  'Type.AsyncIterator',
  'Type.Iterator',
  'Type.Options',
  'Value.Mutate',
] as const;

async function sourceFiles(): Promise<string[]> {
  const roots = ['src', 'extensions', 'scripts', 'tests'];
  const files: string[] = [];
  for (const root of roots) {
    const stack = [join(packageRoot, root)];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (dir === undefined) break;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(path);
        else if (/\.tsx?$/.test(entry.name)) files.push(path);
      }
    }
  }
  return files.sort();
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

void describe('TypeBox compatibility', () => {
  void it('resolves the TypeBox version bundled by the installed Pi, not a private pin', async () => {
    const installed = parseJsonText(
      await readFile(join(packageRoot, 'node_modules/typebox/package.json'), 'utf8'),
    );
    assert.ok(isRecord(installed));
    const version = String(installed['version']);
    assert.match(version, /^1\.3\./, `expected the current Pi TypeBox 1.3.x line, saw ${version}`);

    const manifest = parseJsonText(
      await readFile(join(packageRoot, 'package.json'), 'utf8'),
    );
    assert.ok(isRecord(manifest));
    const peers = manifest['peerDependencies'];
    assert.ok(isRecord(peers));
    // Pi bundles typebox: it must be a "*" peer and must never be bundled.
    assert.equal(peers['typebox'], '*');
    const deps = manifest['dependencies'];
    assert.equal(
      isRecord(deps) ? deps['typebox'] : undefined,
      undefined,
      'typebox must not be a runtime dependency',
    );
    const bundled = manifest['bundledDependencies'];
    assert.equal(Array.isArray(bundled) && bundled.includes('typebox'), false);
  });

  void it('declares Pi and TUI 0.83–0.84 compatibility while keeping supported older lines', async () => {
    const manifest = parseJsonText(
      await readFile(join(packageRoot, 'package.json'), 'utf8'),
    );
    assert.ok(isRecord(manifest));
    const peers = manifest['peerDependencies'];
    assert.ok(isRecord(peers));
    for (const key of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']) {
      const range = String(peers[key]);
      for (const supported of ['0.75.5', '0.81.1', '0.82.1', '0.83.0', '0.84.0']) {
        assert.ok(range.includes(supported), `${key} must still declare ${supported}: ${range}`);
      }
    }
  });

  void it('uses no TypeBox API removed by the current Pi bundled version', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles()) {
      const text = await readFile(file, 'utf8');
      for (const api of REMOVED_TYPEBOX_APIS) {
        // Real member invocations only, so this very list does not self-trip.
        if (new RegExp(`\\b${api.replace('.', '\\.')}\\s*\\(`).test(text)) {
          violations.push(`${file} uses removed TypeBox API ${api}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  void it('compiles the shell-task bg_run schema under TypeBox 1.3', () => {
    const BgRunParams = Type.Object({
      name: Type.String(),
      command: Type.String(),
      description: Type.Optional(Type.String()),
      timeoutSeconds: Type.Optional(Type.Number()),
      notifyOnCompletion: Type.Optional(Type.Boolean()),
      triggerOnCompletion: Type.Optional(Type.Boolean()),
    });
    const compiled = Compile(BgRunParams);
    const input = { name: 'Tests', command: 'npm test', notifyOnCompletion: true };
    assert.equal(compiled.Check(input), true);
    assert.equal(compiled.Check({ name: 'Tests', command: 1 }), false);
    assert.equal(Value.Check(BgRunParams, input), true);
    type BgRunValue = Static<typeof BgRunParams>;
    const typed: BgRunValue = input;
    assert.equal(typed.command, 'npm test');
  });

  void it('keeps Value.Check available for the optional-field shapes the package registers', () => {
    const WithOptional = Type.Object(
      {
        taskId: Type.Optional(Type.String()),
        maxBytes: Type.Optional(Type.Number()),
        tail: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    );
    assert.equal(Value.Check(WithOptional, {}), true);
    assert.equal(Value.Check(WithOptional, { taskId: 'a', tail: true }), true);
    assert.equal(Value.Check(WithOptional, { taskId: 5 }), false);
  });
});
