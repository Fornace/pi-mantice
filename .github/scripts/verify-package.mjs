// Exercise the existing wire checks from the shipped package, outside the
// checkout. Local Pi devDependencies otherwise mask unresolved peer subpaths.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const root = await mkdtemp(join(tmpdir(), 'pi-mantice-package-'));
const pi = await realpath(join(repo, 'node_modules/.bin/pi'));
try {
  execFileSync('npm', [
    'pack', '--ignore-scripts', '--pack-destination', root,
  ], { cwd: repo, stdio: 'inherit', timeout: 60000 });
  const files = await readdir(root);
  assert.equal(files.length, 1, 'npm pack must produce exactly one artifact');
  const [filename] = files;
  assert.ok(filename.endsWith('.tgz'), 'npm pack did not produce a tarball');
  const tarball = join(root, filename);
  const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
  const entryLines = entries.split('\n').filter(Boolean);
  const bundledRoots = new Set(entryLines.flatMap(entry => {
    const match = entry.match(/^package\/node_modules\/([^/]+)\//);
    return match ? [match[1]] : [];
  }));
  assert.deepEqual([...bundledRoots].sort(), [
    'pi-codex-goal', 'pi-frontier', 'pi-message-sidebar', 'pi-subagent-extension',
  ], 'Packed artifact has unexpected or missing bundled dependencies');
  for (const required of [
    'package/node_modules/pi-codex-goal/extensions/index.ts',
    'package/node_modules/pi-codex-goal/prompts/create-goal.md',
    'package/node_modules/pi-message-sidebar/index.ts',
    'package/node_modules/pi-subagent-extension/index.ts',
    'package/node_modules/pi-subagent-extension/usage-receipts.ts',
  ]) assert.ok(entryLines.includes(required), `Packed artifact missing ${required}`);
  assert.ok(!entryLines.some(entry => entry.startsWith('package/node_modules/pi-subagent-extension/skills/')),
    'Packed artifact must not bundle the fornace-model-routing skill (user-level skill owns it)');
  const integrity = 'sha512-' + createHash('sha512').update(await readFile(tarball)).digest('base64');
  execFileSync('tar', ['-xzf', tarball, '-C', root]);
  const cwd = join(root, 'package');
  const rpc = execFileSync(pi, [
    '--offline', '--no-extensions', '-e', cwd, '--no-themes', '--no-context-files',
    '--mode', 'rpc',
  ], {
    cwd: root, input: JSON.stringify({ type: 'get_commands', id: 'package-load' }) + '\n',
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0' },
  });
  const response = rpc.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .find(event => event.id === 'package-load');
  assert.equal(response?.success, true, 'Extracted package did not answer the Pi RPC load probe');
  const commands = new Set(response.data.commands.map(command => command.name));
  for (const command of ['goal', 'create-goal', 'agents', 'subagent-guard', 'sidebar',
    'mantice-guard', 'mantice-child-budget', 'mantice-setup']) {
    assert.ok(commands.has(command), `Extracted package did not load ${command}`);
  }
  for (const script of ['verify-session-wire.mjs', 'verify-fast-wire.mjs']) {
    execFileSync(process.execPath, [join(cwd, 'tools', script)], {
      cwd, env: { ...process.env, PI_TEST_BIN: pi }, stdio: 'inherit', timeout: 180000,
    });
  }
  console.log(`Packed wire verification passed: ${filename} ${integrity}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
