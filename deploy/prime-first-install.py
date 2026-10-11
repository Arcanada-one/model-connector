#!/usr/bin/env python3
"""Prime owned first-install preparation/recovery. No activation or issuer verb."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import stat
import socket
import selectors
import signal
import subprocess
import sys
import time
import uuid

ROOT = Path('/var/lib/arcanada-deploy')
RELEASE = Path('/etc/arcanada/deploy-env/prime-release.json')
CHECKER_SHA = '3b1b40a503d3eb130b3b0174db628c6205f3d9fdef57cc0443c0ec6843174c30'
HELPERS = Path('/usr/local/lib/arcanada-compose-broker')
SHA = re.compile('[0-9a-f]{40}')
ID = re.compile('[0-9a-f]{64}')
DIGEST = re.compile('sha256:[0-9a-f]{64}')
ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/root', 'LC_ALL': 'C', 'GIT_TERMINAL_PROMPT': '0'}

class Refusal(Exception): pass


def protected(path, uid=0, private=False):
    for node in [*reversed(path.parents), path]:
        st = node.lstat()
        if stat.S_ISLNK(st.st_mode) or st.st_uid not in (0,uid) or st.st_mode & 0o022:
            raise Refusal('custody')
        if node != path and not stat.S_ISDIR(st.st_mode): raise Refusal('parent')
    st=path.lstat()
    if st.st_uid != uid: raise Refusal("owner")
    if not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)): raise Refusal('kind')
    if stat.S_ISREG(st.st_mode) and st.st_nlink != 1: raise Refusal('links')
    if private and stat.S_IMODE(st.st_mode) != (0o700 if stat.S_ISDIR(st.st_mode) else 0o600):
        raise Refusal('mode')


def unique(items):
    out={}
    for key,value in items:
        if key in out: raise Refusal('duplicate')
        out[key]=value
    return out


def read_json(path):
    raw=path.read_bytes()
    if len(raw)>65536: raise Refusal('size')
    return json.loads(raw,object_pairs_hook=unique)


def store(path,data):
    pending=path.with_name('.pending-'+uuid.uuid4().hex)
    fd=os.open(pending,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f:
        json.dump(data,f,sort_keys=True);f.flush();os.fsync(f.fileno())
    os.replace(pending,path)
    fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


class Native:
    def __init__(self): self.deadline=time.monotonic()+60
    def call(self,argv,env=None):
        """Bounded Linux capture; group custody ends at leader reap.

        Reuses process_observation.run's waitid/WNOWAIT receiving pattern.
        No escaped-descendant, host-failure or sandbox guarantee is made.
        """
        started=time.monotonic(); end=min(self.deadline,started+15)
        reserve=1.0
        if end-started<=reserve: raise Refusal('deadline')
        if not hasattr(os,'WNOWAIT'): raise Refusal('native_unsupported')
        proc=None; selector=None; reason=None; cleanup=True; complete=False
        buffers={'stdout':bytearray(),'stderr':bytearray()}
        self.last_observation={'stdout_bytes':0,'stderr_bytes':0,
                               'escaped_descendants':'NOT_MEASURED',
                               'cleanup_scope':'owned_group_signals_and_leader_reap'}
        def drain(until):
            nonlocal reason
            while selector.get_map() and time.monotonic()<until:
                for key,_ in selector.select(min(.02,max(0,until-time.monotonic()))):
                    try: block=os.read(key.fileobj.fileno(),8192)
                    except BlockingIOError: continue
                    if not block:
                        selector.unregister(key.fileobj);continue
                    remaining=65536-len(buffers[key.data])
                    buffers[key.data].extend(block[:remaining])
                    if len(block)>remaining:
                        reason='native_capture_limit';return
                return
        try:
            proc=subprocess.Popen(argv,env=env or ENV,stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                                  start_new_session=True)
            selector=selectors.DefaultSelector()
            for name,pipe in [('stdout',proc.stdout),('stderr',proc.stderr)]:
                os.set_blocking(pipe.fileno(),False)
                selector.register(pipe,selectors.EVENT_READ,name)
            while reason is None:
                drain(end-reserve)
                info=os.waitid(os.P_PID,proc.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)
                if reason is not None: break
                if info is not None: break
                if not selector.get_map(): time.sleep(min(.01,max(0,end-reserve-time.monotonic())))
                if time.monotonic()>=end-reserve:
                    reason='native_timeout';break
        except (OSError,ValueError,RuntimeError,subprocess.SubprocessError):
            reason='native_capture_unknown'
        finally:
            if proc is not None:
                # Never poll/wait before the final group signal: reserve PID/PGID.
                for sig in (signal.SIGTERM,signal.SIGKILL):
                    try: os.killpg(proc.pid,sig)
                    except ProcessLookupError: pass
                    except OSError: cleanup=False
                    if sig==signal.SIGTERM:
                        time.sleep(min(.05,max(0,end-time.monotonic())))
                if not cleanup:
                    # Only the unreaped directly owned child; never a foreign PID.
                    try: proc.kill()
                    except OSError: cleanup=False
                try: proc.wait(timeout=max(.001,min(.5,end-time.monotonic())))
                except (OSError,subprocess.TimeoutExpired): cleanup=False
                if selector is not None:
                    try:
                        while selector.get_map() and time.monotonic()<end:
                            drain(end)
                            if reason=='native_capture_limit': break
                    except (OSError,ValueError,RuntimeError):
                        reason=reason or 'native_capture_unknown'
                    if selector.get_map(): reason=reason or 'native_capture_incomplete'
                    complete=not bool(selector.get_map()) and reason!='native_capture_limit'
                    try: selector.close()
                    except OSError: cleanup=False
                for pipe in (proc.stdout,proc.stderr):
                    if pipe is not None: pipe.close()
            elif selector is not None: selector.close()
        self.last_observation.update(stdout_bytes=len(buffers['stdout']),
                                     stderr_bytes=len(buffers['stderr']),
                                     capture_complete=complete,
                                     leader_reaped=proc is not None and proc.returncode is not None,
                                     cleanup='PASS' if cleanup and proc is not None else 'NOT_MEASURED',
                                     duration_seconds=time.monotonic()-started)
        if not cleanup: raise Refusal('native_cleanup_unknown')
        if reason is not None: raise Refusal(reason)
        if proc is None or proc.returncode!=0: raise Refusal('native_refused')
        try: return buffers['stdout'].decode('utf-8').strip()
        except UnicodeError: raise Refusal('native_encoding') from None
    def project(self):
        raw=self.call(['/usr/bin/docker','ps','-aq','--no-trunc','--filter','label=com.docker.compose.project=prime'])
        ids=raw.splitlines() if raw else []
        if any(not ID.fullmatch(i) for i in ids): raise Refusal('id')
        return ids
    def port_free(self,port):
        with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as sock:
            try: sock.bind(("127.0.0.1",port))
            except OSError: raise Refusal("port_occupied") from None

    def identity(self,ident):
        raw=self.call(['/usr/bin/docker','inspect','--format',
            '{{.Id}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.project"}}|'
            '{{index .Config.Labels "com.docker.compose.service"}}|'
            '{{index .Config.Labels "org.arcanada.deploy.attempt"}}|'
            '{{index .Config.Labels "com.docker.compose.project.config_files"}}',ident])
        return raw.split('|')


class Engine:
    def __init__(self,root=ROOT,release=RELEASE,native=None,uid=0,checker=None):
        self.root=Path(root);self.release=Path(release);self.native=native or Native();self.uid=uid
        self.private=self.root/'prime-first-install';self.checkout=self.root/'prime'
        self.checker=checker
    def lock(self):
        protected(self.root,self.uid)
        if not self.private.exists(): self.private.mkdir(mode=0o700)
        protected(self.private,self.uid,True)
        fd=os.open(self.private/'lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        protected(self.private/'lock',self.uid,True)
        try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BaseException: os.close(fd);raise
        return fd
    def contract(self,sha):
        if not SHA.fullmatch(sha): raise Refusal('sha')
        protected(self.release,self.uid,True); data=read_json(self.release)
        if set(data)!={'schema','source_sha','image','port','compose_sha256'} or data['schema']!='PrimeFirstInstall/v1':
            raise Refusal('contract')
        if data['source_sha']!=sha: raise Refusal('source')
        if not re.fullmatch(r'ghcr\.io/arcanada-one/vocatlas-factory@sha256:[0-9a-f]{64}',data['image']): raise Refusal('image')
        if type(data['port']) is not int or not 1024<=data['port']<=65535: raise Refusal('port')
        if not ID.fullmatch(data['compose_sha256']): raise Refusal('hash')
        protected(self.checkout,self.uid)
        file=self.checkout/'deploy/compose.prime.yml'; protected(file,self.uid)
        if hashlib.sha256(file.read_bytes()).hexdigest()!=data['compose_sha256']: raise Refusal('compose')
        git=['/usr/bin/git','-C',str(self.checkout)]
        if self.native.call(git+['remote','get-url','origin'])!='https://github.com/Arcanada-one/vocatlas-factory.git': raise Refusal('repository')
        if self.native.call(git+['rev-parse','HEAD'])!=sha: raise Refusal('head')
        self.native.call(git+['merge-base','--is-ancestor',sha,'origin/main'])
        if self.native.call(git+['status','--porcelain','--untracked-files=no']): raise Refusal('drift')
        flags=self.native.call(git+['ls-files','-v'])
        if any(line and line[0]!='H' for line in flags.splitlines()): raise Refusal('hidden_drift')
        image_id=self.native.call(['/usr/bin/docker','image','inspect','--format','{{.Id}}',data['image']])
        revision=self.native.call(['/usr/bin/docker','image','inspect','--format',
                                  '{{index .Config.Labels "org.opencontainers.image.revision"}}',data['image']])
        if not DIGEST.fullmatch(image_id) or revision!=sha: raise Refusal('image_source')
        env=dict(ENV,PRIME_IMAGE=data['image'],PRIME_HEALTH_PORT=str(data['port']))
        raw=self.native.call(['/usr/bin/docker','compose','--env-file','/dev/null','-p','prime','-f',str(file),'config','--format','json'],env)
        checker=self.checker
        if checker is None:
            path=HELPERS/(CHECKER_SHA+'.py'); protected(path,0,True)
            if hashlib.sha256(path.read_bytes()).hexdigest()!=CHECKER_SHA: raise Refusal('checker')
            checker=runpy.run_path(str(path))['check']
        checker(json.loads(raw,object_pairs_hook=unique),data['image'],data['port'])
        return dict(data,image_id=image_id,release_hash=hashlib.sha256(self.release.read_bytes()).hexdigest())
    def arm(self,sha):
        fd=self.lock()
        try:
            if (self.private/'receipt.json').exists(): raise Refusal('existing_custody')
            data=self.contract(sha)
            if self.native.project(): raise Refusal('not_absent')
            self.native.port_free(data['port'])
            attempt=uuid.uuid4().hex
            override=self.private/'attempt.json'
            store(override,{'services':{'health':{'labels':{'org.arcanada.deploy.attempt':attempt}}}})
            record={'schema':'PrimeOwnedAbsence/v1','attempt':attempt,'phase':'ARMED','release':data,
                    'override_sha256':hashlib.sha256(override.read_bytes()).hexdigest(),'container_id':None}
            store(self.private/'receipt.json',record)
            return attempt
        finally: os.close(fd)
    def load(self,attempt):
        if not re.fullmatch('[0-9a-f]{32}',attempt): raise Refusal('attempt')
        path=self.private/'receipt.json';protected(path,self.uid,True); record=read_json(path)
        if record.get('schema')!='PrimeOwnedAbsence/v1' or record.get('attempt')!=attempt: raise Refusal('receipt')
        protected(self.release,self.uid,True)
        if hashlib.sha256(self.release.read_bytes()).hexdigest()!=record['release']['release_hash']: raise Refusal('release_changed')
        override=self.private/'attempt.json';protected(override,self.uid,True)
        if hashlib.sha256(override.read_bytes()).hexdigest()!=record['override_sha256']: raise Refusal('override_changed')
        return record
    def owned(self,record,ident):
        if not isinstance(ident,str) or not ID.fullmatch(ident): raise Refusal('container')
        file=self.checkout/'deploy/compose.prime.yml';protected(file,self.uid)
        if hashlib.sha256(file.read_bytes()).hexdigest()!=record['release']['compose_sha256']: raise Refusal('source_changed')
        files=','.join([str(self.checkout/'deploy/compose.prime.yml'),str(self.private/'attempt.json')])
        expected=[ident,record['release']['image_id'],'prime','health',record['attempt'],files]
        if self.native.project()!=[ident] or self.native.identity(ident)!=expected: raise Refusal('foreign_identity')
    def bind(self,attempt):
        fd=self.lock()
        try:
            r=self.load(attempt)
            if r['phase']!='ARMED' or r['container_id'] is not None: raise Refusal('already_bound')
            ids=self.native.project()
            if len(ids)!=1: raise Refusal('ambiguous')
            self.owned(r,ids[0]);r.update(container_id=ids[0],phase='BOUND');store(self.private/'receipt.json',r)
        finally: os.close(fd)
    def rollback(self,attempt):
        fd=self.lock()
        try:
            r=self.load(attempt)
            if r['phase'] not in ('BOUND','STOPPING'): raise Refusal('unbound')
            ident=r['container_id'];self.owned(r,ident)
            r['phase']='STOPPING';store(self.private/'receipt.json',r)
            self.native.call(['/usr/bin/docker','stop','--time','10',ident])
            self.owned(r,ident)
            self.native.call(['/usr/bin/docker','rm',ident])
            if self.native.project(): raise Refusal('absence_unknown')
            r['phase']='ROLLED_BACK';store(self.private/'receipt.json',r)
        finally: os.close(fd)


def main():
    try:
        if os.geteuid()!=0 or len(sys.argv)!=3: raise Refusal('arguments')
        action,value=sys.argv[1:];engine=Engine()
        if action=='check': engine.contract(value)
        elif action=='arm': print(engine.arm(value));return 0
        elif action=='bind': engine.bind(value)
        elif action=='rollback': engine.rollback(value)
        else: raise Refusal('verb')
        print('PRIME_FIRST_INSTALL_SOURCE_PATH_PASS');return 0
    except Exception:
        print('PRIME_FIRST_INSTALL_REFUSED',file=sys.stderr);return 1

if __name__=='__main__':sys.exit(main())
