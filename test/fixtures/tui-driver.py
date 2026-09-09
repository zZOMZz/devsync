"""Exercise real PTY input against the CLI with a disposable SSH stand-in."""
import os, sys, pty, select, signal, time, tempfile, pathlib, json, re, shutil, termios, fcntl, struct

node, cli, scenario = sys.argv[1:]
base = pathlib.Path(tempfile.mkdtemp(prefix='ds-tui-', dir='/private/tmp' if sys.platform == 'darwin' else None))
root = base / 'project'
home = base / 'home'
bin_dir = base / 'bin'
for directory in [root, home / '.ssh', bin_dir, root / '.sync']:
    directory.mkdir(parents=True, exist_ok=True)
(home / '.ssh/config').write_text('Host devbox\n  User alice\n  Port 2202\n')
config = {'remote': {'host': 'devbox', 'username': 'alice', 'port': 2202, 'path': '/srv/alice/project'}}
(root / '.sync/config.json').write_text(json.dumps(config))
(root / '.sync/auth.json').write_text('{}')
fake = base / 'ssh.cjs'
fake.write_text('''const fs=require('fs'); const args=process.argv.slice(2);
if(args.includes('-G')) { console.log('user alice\\nport 2202\\nhostname devbox'); }
else { fs.appendFileSync(process.env.TUI_CALLS, args.at(-1).includes('SYNC_HOME')?'probe\\n':'path\\n');
if(process.env.TUI_SLOW) setTimeout(()=>console.log('SYNC_HOME=/srv/alice'),30000);
else if(args.at(-1).includes('SYNC_LINKS')) process.stdout.write('0'.repeat(64)+'  ./old.txt\\n'+'0'.repeat(64)+'  ./deleted.txt\\n'+String.fromCharCode(0)+'SYNC_LINKS'+String.fromCharCode(0));
else if(args.at(-1).includes('xargs -0')) console.log('16\\n32');
else console.log(args.at(-1).includes('SYNC_HOME')?'SYNC_HOME=/srv/alice':'SYNC_PATH_OK'); }
''')
import shlex
shim = bin_dir / 'ssh'
shim.write_text('#!/bin/sh\nunset NODE_OPTIONS\nexec '+shlex.quote(node)+' '+shlex.quote(str(fake))+' "$@"\n')
shim.chmod(0o700)
env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / '.config'), PATH=str(bin_dir)+os.pathsep+os.environ['PATH'], TERM='dumb' if scenario == 'plain' else 'xterm-256color', NO_COLOR='1', TUI_CALLS=str(base / 'calls'))
if scenario == 'stage-interrupt': env['TUI_SLOW']='1'
if scenario == 'preview':
    (root / 'new.txt').write_text('added')
    (root / 'old.txt').write_text('updated')
pid, master = pty.fork()
if pid == 0:
    if scenario.startswith('confirm-'):
        module = (pathlib.Path(cli).resolve().parent.parent / 'src/terminal-ui.mjs').as_uri()
        script = 'import { TerminalUI } from '+json.dumps(module)+'; const result = await new TerminalUI().confirmSync({backup:{enabled:true}}); console.log("RESULT "+JSON.stringify(result));'
        os.execvpe(node, [node, '--input-type=module', '-e', script], env)
    os.execvpe(node, [node, cli, 'preview' if scenario == 'preview' else 'config', '--dir', str(root)], env)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 35, 44, 0, 0))
raw = b''
code = None
ansi = re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))')
def text(): return ansi.sub('', raw.decode('utf8', errors='replace'))
def pump(timeout=0.1):
    global raw, code
    if select.select([master], [], [], timeout)[0]:
        try: raw += os.read(master, 65536)
        except OSError: pass
    if code is None:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done: code = os.waitstatus_to_exitcode(status)
def wait_for(value, since=0):
    deadline=time.monotonic()+12
    while value not in text()[since:]:
        pump()
        if code is not None or time.monotonic()>deadline:
            raise AssertionError('Waiting for '+repr(value)+'\n'+text()[-3000:])
    return len(text())
def send(value):
    mark=len(text())
    os.write(master, value.encode('utf8'))
    return mark
def finish():
    deadline=time.monotonic()+12
    while code is None and time.monotonic()<deadline: pump()
    assert code is not None, text()[-3000:]
    for _ in range(3): pump(0.03)
try:
    if scenario.startswith('confirm-'):
        wait_for('选择同步方式')
        send('\x1b[A\r' if scenario == 'confirm-skip' else '\r')
        finish()
        assert code == 0, text()
        result = json.loads(text().split('RESULT ')[-1].strip())
        assert result == {'confirmed': scenario == 'confirm-skip', 'skipBackup': scenario == 'confirm-skip'}, result
    elif scenario == 'preview':
        finish()
        assert code == 0, text()
        for value in ['新增 1 个文件', '覆盖 1 个文件', '删除 1 个文件', 'new.txt', 'old.txt', 'deleted.txt', '本次备份 2 个文件', '48 B']:
            assert value in text(), text()
        assert (root / '.sync/preview.json').exists()
    else: wait_for('选择开发机')
    if scenario == 'preview' or scenario.startswith('confirm-'): pass
    elif scenario in ['escape', 'ctrl-c', 'sigterm']:
        if scenario == 'sigterm': os.kill(pid, signal.SIGTERM)
        else: send('\x1b' if scenario == 'escape' else '\x03')
        finish()
        assert code == (1 if scenario == 'escape' else 130), (code, text())
        assert json.loads((root / '.sync/config.json').read_text()) == config
        assert json.loads((root / '.sync/auth.json').read_text()) == {}
    else:
        mark=send('1\n' if scenario == 'plain' else '\r'); wait_for('开发机账号', mark)
        mark=send('\n' if scenario == 'plain' else '\r'); wait_for('SSH 端口', mark)
        if scenario == 'success':
            mark=send('\x150\r'); wait_for('SSH 端口必须',mark)
            mark=send('\x152202\r')
        else: mark=send('\n' if scenario == 'plain' else '\r')
        wait_for('认证方式',mark)
        if scenario == 'success':
            mark=send('\x1b[B\x1b[B\r'); wait_for('开发机密码',mark)
            mark=send('not-visible-秘密\r'); wait_for('远端项目绝对路径',mark)
            mark=send('\x15/srv/alice/中文项目\r'); wait_for('备份策略',mark)
            mark=send('\r'); wait_for('确认保存以上配置？',mark)
            send('\r')
        elif scenario == 'stage-interrupt':
            mark=send('\r'); wait_for('验证 SSH 连接和认证',mark)
            # Wait until the child is actually running, then interrupt the phase.
            deadline=time.monotonic()+5
            while not (base / 'calls').exists() and time.monotonic()<deadline: pump()
            send('\x03')
        else:
            mark=send('1\n'); wait_for('远端项目绝对路径',mark)
            mark=send('\n'); wait_for('备份策略',mark)
            mark=send('\n'); wait_for('确认保存以上配置？',mark)
            send('\n')
        finish()
        if scenario == 'stage-interrupt':
            assert code == 130, (code,text())
            assert json.loads((root / '.sync/config.json').read_text()) == config
        else:
            assert code == 0, (code,text())
            calls=(base / 'calls').read_text().splitlines()
            assert calls.count('probe') == 1 and calls.count('path') == 1, calls
            if scenario == 'success':
                assert json.loads((root / '.sync/config.json').read_text())['remote']['path'] == '/srv/alice/中文项目'
                assert json.loads((root / '.sync/auth.json').read_text())['password'] == 'not-visible-秘密'
                assert 'not-visible' not in text() and '秘密' not in text(), text()
                assert not re.search(r'\x1b\[[0-9;]*m', raw.decode('utf8',errors='replace'))
            if scenario == 'plain': assert b'\x1b[' not in raw, repr(raw)
    assert not (root / '.sync/command.lock').exists(), 'project lock leaked'
    flags=termios.tcgetattr(master)[3]
    assert flags & termios.ICANON and flags & termios.ECHO, 'terminal raw mode leaked'
    print(json.dumps({'scenario':scenario,'exit':code,'checks':'passed'},ensure_ascii=False))
finally:
    if code is None:
        os.kill(pid,signal.SIGKILL)
        os.waitpid(pid,0)
    os.close(master)
    shutil.rmtree(base)
