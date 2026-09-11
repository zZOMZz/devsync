"""Exercise actual zsh ZLE completion without executing completed commands."""
import os, sys, pty, select, time, tempfile, pathlib, re, json, signal, shutil, shlex
zsh, script = sys.argv[1:]
root = pathlib.Path(tempfile.mkdtemp(prefix='ds-completion-'))
(root / 'folder with space').mkdir()
(root / 'file-only').write_text('')
env = dict(os.environ, HOME=str(root), ZDOTDIR=str(root), TERM='xterm', LC_ALL='en_US.UTF-8')
pid, master = pty.fork()
if pid == 0:
    os.chdir(root)
    os.execvpe(zsh, [zsh, '-f'], env)
raw=b''; code=None
ansi=re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))')
def text(): return ansi.sub('',raw.decode('utf8',errors='replace'))
def pump(timeout=.1):
    global raw
    if select.select([master],[],[],timeout)[0]:
        try: raw += os.read(master,65536)
        except OSError: pass

def send(value): os.write(master,value.encode())
def wait(value, since=0):
    deadline=time.monotonic()+8
    while value not in text()[since:]:
        pump()
        if time.monotonic()>deadline: raise AssertionError('missing '+value+'\n'+text()[-5000:])
try:
    setup="autoload -Uz compinit; compinit -D; source "+shlex.quote(script)+"; PS1='READY> '; bindkey -e; unsetopt menucomplete; setopt autolist; function capture_buffer() { print -r -- CAPTURE:$BUFFER:END; BUFFER=''; zle reset-prompt; }; zle -N capture_buffer; bindkey '^X' capture_buffer; print INIT_DONE"
    send(setup+'\n'); wait('\r\nINIT_DONE\r\n')
    captures=[]
    def capture(value, expected):
        mark=len(text()); send(value+'\t'); pump(.2); send('\x18'); wait(':END',mark)
        found=re.findall(r'CAPTURE:(.*?):END',text()[mark:])[-1].strip()
        assert found==expected,(value,found,text()[-3000:])
        captures.append(found)
    capture('devsync dash','devsync dashboard')
    mark=len(text()); send('devsync st\t\t'); pump(.3); send('\x18'); wait(':END',mark)
    for candidate in ['start','status','stop']: assert candidate in text()[mark:],text()[mark:]
    capture('devsync status --verbo','devsync status --verbose')
    capture('devsync --dir ./ status --verbo','devsync --dir ./ status --verbose')
    capture('devsync sync --ye','devsync sync --yes')
    capture('devsync status --dir fol','devsync status --dir folder\\ with\\ space/')
    capture('devsync completion ins','devsync completion install')
    capture('devsync completion install z','devsync completion install zsh')
    capture('devsync completion unins','devsync completion uninstall')
    capture('devsync status --ye','devsync status --ye')
    assert '_worker' not in text(),text()
    send('exit\n')
    print(json.dumps({'checks':'passed','captures':captures}))
finally:
    try: os.kill(pid,signal.SIGKILL)
    except ProcessLookupError: pass
    os.waitpid(pid,0)
    os.close(master); shutil.rmtree(root)
