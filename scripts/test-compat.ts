import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseJsonText } from '../src/core/common.js';
import { isolatedTestEnv } from '../src/testing/normalize.js';

const requiredVersions = ['0.75.5', '0.81.1', '0.82.1', '0.83.0', '0.84.1'] as const;
const root = fileURLToPath(new URL('../', import.meta.url));
const removedTypeBoxApis = [
  'Type.Base',
  'Type.Awaited',
  'Type.Promise',
  'Type.AsyncIterator',
  'Type.Iterator',
  'Type.Options',
  'Value.Mutate',
] as const;

interface PackFileEntry {
  filename: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    env: { ...env, NPM_CONFIG_CACHE: env['NPM_CONFIG_CACHE'] ?? '/tmp/pi-npm-cache' },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed in ${cwd}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function parsePack(text: string): PackFileEntry {
  const parsed = parseJsonText(text);
  if (!Array.isArray(parsed) || !isRecord(parsed[0])) {
    throw new Error('npm pack JSON output must contain one package object');
  }
  return { filename: requireString(parsed[0]['filename'], 'pack filename') };
}

function verifyManifest(): void {
  const manifest = parseJsonText(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!isRecord(manifest)) throw new Error('package.json must be an object');
  const peers = manifest['peerDependencies'];
  if (!isRecord(peers)) throw new Error('peerDependencies must be an object');
  if (peers['typebox'] !== '*') throw new Error('typebox must be a "*" peer dependency');
  for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']) {
    const range = peers[name];
    if (
      typeof range !== 'string' ||
      !range.includes('0.83') ||
      !range.includes('0.84')
    ) {
      throw new Error(`${name} must declare Pi 0.83 and 0.84 support`);
    }
  }
  const dependencies = manifest['dependencies'];
  if (isRecord(dependencies) && dependencies['typebox'] !== undefined) {
    throw new Error('typebox must not be a runtime dependency');
  }
}

async function scanPackedSource(packageDir: string, version: string): Promise<void> {
  const stack = [packageDir];
  let scanned = 0;
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') stack.push(path);
        continue;
      }
      if (!/\.(?:ts|js|mjs|cjs|json)$/.test(entry.name)) continue;
      scanned++;
      const text = await readFile(path, 'utf8');
      for (const api of removedTypeBoxApis) {
        if (new RegExp(`\\b${api.replace('.', '\\.')}\\s*\\(`).test(text)) {
          throw new Error(`Pi ${version}: ${path} uses removed TypeBox API ${api}`);
        }
      }
    }
  }
  if (scanned === 0) throw new Error(`Pi ${version}: no packed source files were scanned`);
}

function expectedTypeBox(version: string): { spec: string; prefix: string } {
  return version.startsWith('0.83') || version.startsWith('0.84')
    ? { spec: 'typebox@1.3.7', prefix: '1.3.' }
    : { spec: 'typebox@1.1.38', prefix: '1.1.' };
}

async function smokeVersion(version: string, tarballPath: string): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), `pi-bg-compat-${version}-`));
  const typebox = expectedTypeBox(version);
  try {
    run('npm', ['init', '-y'], temp);
    run(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        tarballPath,
        `@earendil-works/pi-coding-agent@${version}`,
        `@earendil-works/pi-tui@${version}`,
        typebox.spec,
      ],
      temp,
    );

    const packageDir = join(temp, 'node_modules', 'pi-background-tasks');
    const nestedTypeBox = join(packageDir, 'node_modules', 'typebox');
    if (existsSync(nestedTypeBox)) {
      throw new Error(`Pi ${version}: package installed a private TypeBox copy`);
    }
    const typeboxManifest = parseJsonText(
      readFileSync(join(temp, 'node_modules', 'typebox', 'package.json'), 'utf8'),
    );
    if (!isRecord(typeboxManifest)) throw new Error('TypeBox package manifest must be an object');
    const installedTypeBox = requireString(typeboxManifest['version'], 'TypeBox version');
    if (!installedTypeBox.startsWith(typebox.prefix)) {
      throw new Error(`Pi ${version}: expected TypeBox ${typebox.prefix}x, got ${installedTypeBox}`);
    }

    await scanPackedSource(packageDir, version);

    const cli = join(
      temp,
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'dist',
      'cli.js',
    );
    const extension = join(packageDir, 'extensions', 'background-tasks.ts');
    const agentDir = join(temp, 'agent');
    run(
      process.execPath,
      [
        cli,
        '--no-extensions',
        '-e',
        extension,
        '--offline',
        '--no-tools',
        '--no-session',
        '-p',
        '/jobs',
      ],
      temp,
      {
        ...process.env,
        ...isolatedTestEnv,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions'),
      },
    );
    console.log(`Pi ${version}: startup passed with TypeBox ${installedTypeBox}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

verifyManifest();
const pack = parsePack(run('npm', ['pack', '--json'], root));
const tarballPath = join(root, pack.filename);
try {
  for (const version of requiredVersions) await smokeVersion(version, tarballPath);
  console.log(`Compatibility passed: Pi ${requiredVersions.join(', ')}`);
} finally {
  await rm(tarballPath, { force: true });
}
