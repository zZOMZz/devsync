import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { command, quote, writeJson } from '../src/core.mjs';
import { ssh } from '../src/remote.mjs';
import { Session } from '../src/session.mjs';
import { startWorker, stopWorker } from '../src/worker.mjs';

// Opt-in: a disposable loopback sshd, private host/client keys and isolated
// known_hosts, SSH config, remote HOME, agent installation and Mutagen daemon.
// No developer host, key, agent, or user SSH configuration is used.
test('real SSH synchronizes with an explicit key and reconnects with the saved transport', {
  skip: !process.env.DEVSYNC_TEST_SSHD || !process.env.DEVSYNC_TEST_MUTAGEN || process.platform === 'win32',
  timeout: 90000,
}, async t => {
  const base = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'ds-ssh-'));
  const root = path.join(base, 'local'), home = path.join(base, 'remote');
  const target = path.join(home, 'project'), bin = path.join(base, 'bin');
  for (const dir of [root, home, target, bin]) await fs.mkdir(dir);
  let server, session, agent;
  const oldPath = process.env.PATH;
  const oldAgent = process.env.SSH_AUTH_SOCK;
  t.after(async () => {
    if (session) {
      await stopWorker(root).catch(() => {});
      await session.run(['sync', 'terminate', session.name], { timeout: 10000 }).catch(() => {});
      await session.run(['daemon', 'stop'], { timeout: 10000 }).catch(() => {});
    }
    if (server && server.exitCode === null) {
      server.kill();
      await new Promise(resolve => server.once('exit', resolve));
    }
    if (agent && agent.exitCode === null) {
      agent.kill();
      await new Promise(resolve => agent.once('exit', resolve));
    }
    process.env.PATH = oldPath;
    if (oldAgent === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = oldAgent;
    await fs.rm(base, { recursive: true, force: true });
  });
  for (const name of ['host', "client key's", 'second-key'])
    await command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(base, name)]);
  const key = path.join(base, "client key's");
  await fs.copyFile(key + '.pub', path.join(base, 'authorized_keys'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const clientConfig = path.join(base, 'client.conf');
  const isolatedConfig = `Host fixture\n  HostName 127.0.0.1\nHost *\n  IdentityAgent none\n  IdentitiesOnly yes\n  IdentityFile none\n  UserKnownHostsFile ${base}/known_hosts\n`;
  await fs.writeFile(clientConfig, isolatedConfig);
  for (const name of ['ssh', 'scp']) {
    const actual = (await command('/bin/sh', ['-c', `command -v ${name}`])).trim();
    await fs.writeFile(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' ${quote(name)} >> ${quote(path.join(base, 'calls'))}\nexec ${quote(actual)} -F ${quote(clientConfig)} "$@"\n`, { mode: 0o700 });
  }
  const remoteShell = path.join(base, 'remote.sh');
  await fs.writeFile(remoteShell, `#!/bin/sh\nexport HOME=${quote(home)}\ncd "$HOME" || exit 1\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`, { mode: 0o700 });
  await fs.writeFile(path.join(base, 'sshd.conf'), `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${base}/host\nPidFile ${base}/pid\nAuthorizedKeysFile ${base}/authorized_keys\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nLogLevel ERROR\nForceCommand ${remoteShell}\nSubsystem sftp internal-sftp\n`);
  // Legacy scp avoids an internal-sftp subsystem bypassing the isolated HOME.
  const scpShim = path.join(bin, 'scp');
  await fs.writeFile(scpShim, (await fs.readFile(scpShim, 'utf8')).replace(' "$@"', ' -O "$@"'));
  server = spawn(process.env.DEVSYNC_TEST_SSHD, ['-D', '-e', '-f', path.join(base, 'sshd.conf')], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  server.stderr.on('data', b => { errors += b; });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(server.exitCode, null, errors);
  process.env.PATH = bin + path.delimiter + oldPath;
  const cfg = { identityFile: key, remote: { host: 'fixture', username: os.userInfo().username, port, path: target } };
  assert.equal(await ssh(root, cfg, {}, 'printf authenticated'), 'authenticated');
  await assert.rejects(ssh(root, { ...cfg, identityFile: undefined }, {}, 'true'), /Permission denied/);
  await writeJson(path.join(root, '.sync/config.json'), cfg);
  await fs.writeFile(path.join(root, 'hello.txt'), 'first');
  session = new Session(root, path.resolve(process.env.DEVSYNC_TEST_MUTAGEN), {});
  await session.create(cfg);
  await session.resume();
  await session.flush();
  assert.equal(await fs.readFile(path.join(target, 'hello.txt'), 'utf8'), 'first');
  assert.match(await fs.readFile(path.join(base, 'calls'), 'utf8'), /scp/);
  await session.run(['daemon', 'stop']);
  // The worker must restart the daemon using the accepted transport, even if
  // the user has edited connection settings since the last confirmation.
  await writeJson(path.join(root, '.sync/config.json'), { ...cfg, identityFile: '/unconfirmed-key' });
  session = new Session(root, session.binary, {});
  await startWorker(root, session.binary);
  await fs.writeFile(path.join(root, 'hello.txt'), 'after restart');
  const deadline = Date.now() + 15000;
  while (await fs.readFile(path.join(target, 'hello.txt'), 'utf8') !== 'after restart' && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await fs.readFile(path.join(target, 'hello.txt'), 'utf8'), 'after restart');
  await stopWorker(root);
  await session.pause();
  await session.run(['sync', 'terminate', session.name]);
  await fs.copyFile(path.join(base, 'second-key.pub'), path.join(base, 'authorized_keys'));
  cfg.identityFile = path.join(base, 'second-key');
  await session.create(cfg);
  await session.resume();
  await fs.writeFile(path.join(root, 'hello.txt'), 'rotated key');
  await session.flush();
  assert.equal(await fs.readFile(path.join(target, 'hello.txt'), 'utf8'), 'rotated key');
  // Removing the project key restores ordinary OpenSSH alias configuration.
  await session.pause();
  await session.run(['sync', 'terminate', session.name]);
  await fs.writeFile(clientConfig, isolatedConfig + `  IdentityFile ${base}/second-key\n`);
  delete cfg.identityFile;
  assert.equal(await ssh(root, cfg, {}, 'printf alias'), 'alias');
  await session.create(cfg);
  await session.resume();
  await fs.writeFile(path.join(root, 'hello.txt'), 'alias key');
  await session.flush();
  assert.equal(await fs.readFile(path.join(target, 'hello.txt'), 'utf8'), 'alias key');
  // Agent authentication uses a disposable agent, never the developer agent.
  await session.pause();
  await session.run(['sync', 'terminate', session.name]);
  await session.run(['daemon', 'stop']);
  const agentSocket = path.join(base, 'agent.sock');
  agent = spawn('ssh-agent', ['-D', '-a', agentSocket], { stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 200));
  process.env.SSH_AUTH_SOCK = agentSocket;
  await command('ssh-add', [path.join(base, 'second-key')]);
  await fs.writeFile(clientConfig, isolatedConfig.replace('  IdentityAgent none\n', '').replace('IdentitiesOnly yes', 'IdentitiesOnly no'));
  assert.equal(await ssh(root, cfg, {}, 'printf agent'), 'agent');
  session = new Session(root, session.binary, {});
  await session.create(cfg);
  await session.resume();
  await fs.writeFile(path.join(root, 'hello.txt'), 'agent key');
  await session.flush();
  assert.equal(await fs.readFile(path.join(target, 'hello.txt'), 'utf8'), 'agent key');
});
