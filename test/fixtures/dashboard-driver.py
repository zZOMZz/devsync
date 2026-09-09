"""Real Ink/Clack PTY lifecycle with isolated, controllable project services."""
import os, sys, pty, select, signal, time, tempfile, pathlib, json, re, shutil, termios, fcntl, struct
node, app, scenario = sys.argv[1:]
base = pathlib.Path(tempfile.mkdtemp(prefix='ds-panel-', dir='/private/tmp' if sys.platform == 'darwin' else None)).resolve()
roots = [base / name for name in ['one', 'two', 'extra']]
for root in roots:
    (root / '.sync').mkdir(parents=True)
    (root / '.sync/config.json').write_text(json.dumps({'remote': {'host':'dev','username':'alice','port':22,'path':'/srv/project'}}))
(base / 'projects.json').write_text(json.dumps({'version':1,'projects':[{'root':str(p),'name':p.name} for p in roots[:2]]}))
(base / 'state.json').write_text(json.dumps({str(roots[0]): {'auto':False}, str(roots[1]): {'auto':True}}))
if scenario == 'relocate': roots[0].rename(base / 'moved')
env=dict(os.environ, TERM='xterm-256color', NO_COLOR='1', XDG_CONFIG_HOME=str(base / 'config'), HOME=str(base))
(base/'.ssh').mkdir()
(base/'.ssh/config').write_text('Host dev\n  User alice\n  Port 22\n')
(base/'bin').mkdir()
(base/'bin/ssh').write_text("#!/bin/sh\nprintf 'user alice\\nport 22\\nhostname dev\\n'\n")
(base/'bin/ssh').chmod(0o700)
env['PATH']=str(base/'bin')+os.pathsep+env['PATH']
pid, master = pty.fork()
if pid == 0: os.execvpe(node,[node,app,str(base)],env)
fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',28,54,0,0))
raw=b''; code=None
ansi=re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))')
def text(): return ansi.sub('',raw.decode('utf8',errors='replace'))
def pump(timeout=0.1):
    global raw, code
    if select.select([master],[],[],timeout)[0]:
        try: raw += os.read(master,65536)
        except OSError: pass
    if code is None:
        done,status=os.waitpid(pid,os.WNOHANG)
        if done: code=os.waitstatus_to_exitcode(status)
def wait_for(value,since=0):
    end=time.monotonic()+10
    while value not in text()[since:]:
        pump()
        if code is not None or time.monotonic()>end: raise AssertionError('Waiting for '+repr(value)+'\n'+text()[-3500:])
def send(value):
    mark=len(text()); os.write(master,value.encode()); return mark
def finish():
    end=time.monotonic()+10
    while code is None and time.monotonic()<end: pump()
    assert code is not None, text()[-2500:]
    for _ in range(3): pump(0.02)
try:
    wait_for('项目控制面板'); wait_for('one')
    if scenario in ['manage','cancel-start']:
        mark=send('s'); wait_for('以本地为准同步，是否继续？',mark)
        mark=send('\r' if scenario=='cancel-start' else '\x1b[D\r')
        wait_for('已取消' if scenario=='cancel-start' else '自动同步已开启',mark)
        wait_for('项目控制面板',mark)
        if scenario=='manage':
            mark=send('x'); wait_for('当前项目自动同步已停止',mark)
        send('q')
    elif scenario=='prompt-interrupt':
        mark=send('a'); wait_for('◆  项目目录',mark)
        send('\x03')
    elif scenario=='configure':
        mark=send('c'); wait_for('◆  选择开发机',mark)
        for label in ['开发机账号','SSH 端口','认证方式','远端项目绝对路径','备份策略','确认保存以上配置？']:
            mark=send('\r'); wait_for('◆  '+label,mark)
        mark=send('\r'); wait_for('配置已保存，同步保持暂停',mark)
        send('q')
    elif scenario=='index':
        mark=send('a'); wait_for('◆  项目目录',mark)
        mark=send('\x15'+str(roots[2])+'\r'); wait_for('已登记：extra',mark)
        mark=send('d'); wait_for('仅从面板移除？',mark)
        mark=send('\x1b[D\r'); wait_for('项目记录已移除',mark)
        send('q')
    elif scenario=='relocate':
        wait_for('目录不可用')
        mark=send('l'); wait_for('◆  项目目录',mark)
        mark=send('\x15'+str(base/'moved')+'\r'); wait_for('已登记：moved',mark)
        send('q')
    elif scenario=='details':
        mark=send('\r'); wait_for('远端：',mark)
        fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',20,44,0,0))
        os.kill(pid,signal.SIGWINCH)
        send('\x1b[B\x1b[A'); time.sleep(.1)
        mark=send('\x1b'); wait_for('移除记录',mark)
        send('q')
    elif scenario=='ctrl-c': send('\x03')
    elif scenario=='sigterm': os.kill(pid,signal.SIGTERM)
    finish()
    assert code == (130 if scenario in ['ctrl-c','sigterm','prompt-interrupt'] else 0),(code,text()[-2000:])
    calls=[json.loads(line) for line in (base/'calls').read_text().splitlines()] if (base/'calls').exists() else []
    expected=[['start',str(roots[0])],['stop',str(roots[0])]] if scenario=='manage' else [['configure',str(roots[0])]] if scenario=='configure' else []
    assert calls==expected,calls
    assert json.loads((base/'state.json').read_text())[str(roots[1])]['auto'] is True
    records=json.loads((base/'projects.json').read_text())['projects']
    assert len(records)==2,records
    if scenario=='relocate': assert any(p['root']==str(base/'moved') for p in records)
    assert (roots[2]/'.sync/config.json').exists()
    flags=termios.tcgetattr(master)[3]
    assert flags & termios.ICANON and flags & termios.ECHO,'terminal raw mode leaked'
    assert b'\x1b[?1049h' in raw and b'\x1b[?1049l' in raw,'alternate screen not restored'
    if os.environ.get('DEVSYNC_PANEL_TRANSCRIPT'): pathlib.Path(os.environ['DEVSYNC_PANEL_TRANSCRIPT']).write_text(text())
    print(json.dumps({'scenario':scenario,'checks':'passed'}))
finally:
    if code is None:
        os.kill(pid,signal.SIGKILL);os.waitpid(pid,0)
    os.close(master);shutil.rmtree(base)
