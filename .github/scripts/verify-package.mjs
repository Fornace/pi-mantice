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
  assert.ok(!entries.split('\n').some(entry => entry.startsWith('package/node_modules/')),
    'Wire verification requires a package without checkout dependencies');
  const integrity = 'sha512-' + createHash('sha512').update(await readFile(tarball)).digest('base64');
  execFileSync('tar', ['-xzf', tarball, '-C', root]);
  const cwd = join(root, 'package');
  for (const script of ['verify-session-wire.mjs', 'verify-fast-wire.mjs']) {
    execFileSync(process.execPath, [join(cwd, 'tools', script)], {
      cwd, env: { ...process.env, PI_TEST_BIN: pi }, stdio: 'inherit', timeout: 180000,
    });
  }
  console.log(`Packed wire verification passed: ${filename} ${integrity}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
