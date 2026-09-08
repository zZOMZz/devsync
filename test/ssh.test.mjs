import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { identityPath, sshOptions, prepareSSHTransport } from '../src/ssh-transport.mjs';
import { ssh } from '../src/remote.mjs';
import { connectionError } from '../src/connection.mjs';
import { Session, fingerprint, watchPolicy } from '../src/session.mjs';
import { defaultRules } from '../src/rules.mjs';
import { command, digest, quote, readJson, writeJson } from '../src/core.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'ds-auth-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const remote = { host: 'dev-alias', username: 'alice', port: 2202, path: '/srv/project' };

test('identity paths resolve consistently from project root and reject unusable values', () => {
  const options = { platform: 'linux', home: '/home/alice' };
  assert.equal(identityPath('/project', {}, options), null);
  assert.equal(identityPath('/project', { identityFile: 'keys/dev' }, options), path.resolve('/project', 'keys/dev'));
  assert.equal(identityPath('/project', { identityFile: '~/keys/dev' }, options), path.resolve('/home/alice/keys/dev'));
  for (const identityFile of ['', ' ', null, 123, {}, 'a\nb', 'a\0b', '~other/key'])
    assert.throws(() => identityPath('/project', { identityFile }, options), { code: 'SSH_IDENTITY' });
  assert.throws(() => identityPath('/project', { identityFile: '/key' }, { platform: 'win32' }), { code: 'SSH_IDENTITY_UNSUPPORTED' });
  assert.equal(identityPath('/project', {}, { platform: 'win32' }), null);
  for (const code of ['SSH_IDENTITY', 'SSH_IDENTITY_UNSUPPORTED']) {
    const error = Object.assign(new Error('identity configuration'), { code });
    assert.equal(connectionError(error), error);
  }
});

test('default keys, agent and SSH aliases keep OpenSSH configuration; password stays out of argv', async t => {
  const root = await fixture(t);
  for (const auth of [{}, { password: 'fixture-password' }]) {
    await ssh(root, { remote }, auth, 'true', undefined, async (_bin, args) => {
      assert.ok(!args.includes('-F'));
      assert.ok(!args.includes('-i'));
      assert.ok(!args.includes(auth.password));
      assert.ok(args.includes(auth.password ? 'PreferredAuthentications=password' : 'BatchMode=yes'));
      assert.ok(args.includes('alice@dev-alias'));
      return args.includes('-G') ? 'hostname dev.example.test\n' : 'ok';
    });
    assert.equal(await prepareSSHTransport(root, { remote }, auth), null);
  }
});

test('direct SSH and both Mutagen launchers pass the same key and auth options without shell expansion', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await fixture(t), bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  const oldPath = process.env.PATH;
  t.after(() => { process.env.PATH = oldPath; });
  // These stand-ins return actual argv; scripts are executed by the OS.
  const capture = path.join(root, 'capture.cjs');
  await fs.writeFile(capture, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  for (const name of ['ssh', 'scp'])
    await fs.writeFile(path.join(bin, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(capture)} "$@"\n`, { mode: 0o700 });
  process.env.PATH = bin;
  const cfg = { remote, identityFile: `keys/dev's $(touch ${root}/unexpected) \`whoami\` key` };
  for (const auth of [{}, { password: 'fixture-password' }]) {
    let direct;
    await ssh(root, cfg, auth, 'true', undefined, async (_bin, args) => {
      if (args.includes('-G')) return 'hostname dev.example.test\n';
      direct = args.slice(2, -2);
      return 'ok';
    });
    const transport = await prepareSSHTransport(root, cfg, auth);
    for (const name of ['ssh', 'scp']) {
      const file = path.join(transport.directory, name);
      const forwarded = ['-p', '2202', 'alice@dev-alias', 'a command with spaces'];
      assert.deepEqual(JSON.parse(await command(file, forwarded, { cwd: '/' })), [...direct, ...forwarded]);
      assert.doesNotMatch(await fs.readFile(file, 'utf8'), /fixture-password/);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o700);
    }
    assert.deepEqual(direct, sshOptions(root, cfg, auth));
  }
  await assert.rejects(fs.access(path.join(root, 'unexpected')), { code: 'ENOENT' });
});

test('fresh sessions read the accepted transport instead of edited connection settings', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await fixture(t), binary = path.join(root, 'mutagen');
  const capture = path.join(root, 'env.cjs');
  await fs.writeFile(capture, 'process.stdout.write(process.env.MUTAGEN_SSH_PATH || "unset")');
  await fs.writeFile(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(capture)}\n`, { mode: 0o700 });
  const accepted = { directory: path.join(root, '.sync/ssh/accepted') };
  await writeJson(path.join(root, '.sync/ssh.json'), accepted);
  await writeJson(path.join(root, '.sync/config.json'), { remote, identityFile: '/different-key' });
  const session = new Session(root, binary, {});
  assert.equal(await session.run(['sync', 'resume']), accepted.directory);
  await writeJson(path.join(root, '.sync/ssh.json'), null);
  assert.equal(await session.run(['sync', 'resume']), 'unset');
});

test('creating or removing a key switches the snapshot only after the old daemon stops', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await fixture(t), receipt = path.join(root, '.sync/ssh.json');
  const previous = { directory: '/old-transport' };
  await writeJson(receipt, previous);
  const session = new Session(root, '/unused', {});
  let stops = 0;
  session.run = async args => {
    if (args[0] === 'daemon') {
      assert.equal((await readJson(receipt)).directory, stops ? session.accepted : previous.directory);
      stops++;
    } else if (args[1] === 'list') return '[]';
    else if (args[1] === 'create') {
      const current = await readJson(receipt);
      if (stops === 1) {
        assert.notEqual(current.directory, previous.directory);
        session.accepted = current.directory;
      } else assert.equal(current, null);
    }
    return '';
  };
  await session.create({ remote, identityFile: '/key' });
  await session.create({ remote });
  assert.equal(stops, 2);
});

test('failed daemon shutdown preserves the previously accepted transport', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await fixture(t), receipt = path.join(root, '.sync/ssh.json');
  const previous = { directory: '/old-transport' };
  await writeJson(receipt, previous);
  const session = new Session(root, '/unused', {});
  session.run = async args => {
    if (args[1] === 'list') return '[]';
    throw Error('daemon busy');
  };
  await assert.rejects(session.create({ remote, identityFile: '/key' }), /daemon busy/);
  assert.deepEqual(await readJson(receipt), previous);
  assert.deepEqual(await fs.readdir(path.join(root, '.sync/ssh')), []);
});

test('explicit-key sessions require migration and auth-mode confirmation; existing default-key fingerprints stay stable', {
  skip: process.platform === 'win32',
}, () => {
  const legacy = cfg => digest(JSON.stringify({ root: '/project', remote, identityFile: cfg.identityFile,
    mode: 'one-way-replica', watchPolicy, rules: defaultRules }));
  const cfg = { remote, identityFile: '/key' };
  assert.notEqual(fingerprint('/project', cfg), legacy(cfg));
  assert.notEqual(fingerprint('/project', cfg), fingerprint('/project', cfg, defaultRules, { password: 'fixture' }));
  assert.equal(fingerprint('/project', { remote }), legacy({ remote }));
});
