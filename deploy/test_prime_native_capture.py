"""Real owned child controls; no Docker, provider or production invocation."""
import ctypes
import importlib.util
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('first',Path(__file__).with_name('prime-first-install.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class NativeCaptureTests(unittest.TestCase):
    def invoke(self,source,budget=None):
        n=m.Native()
        if budget is not None:n.deadline=time.monotonic()+budget
        return n,[sys.executable,'-c',source]
    def refuse(self,source,reason,budget=None):
        n,argv=self.invoke(source,budget)
        with self.assertRaisesRegex(m.Refusal,'^'+reason+'$'):n.call(argv)
        self.assertTrue(n.last_observation['leader_reaped'])
        self.assertLessEqual(n.last_observation['stdout_bytes'],65536)
        self.assertLessEqual(n.last_observation['stderr_bytes'],65536)
        return n
    def test_success_and_exact_boundary(self):
        n,a=self.invoke("import sys;sys.stdout.write('x'*65536);sys.stderr.write('y'*65536)")
        self.assertEqual(len(n.call(a)),65536)
        self.assertTrue(n.last_observation['capture_complete'])
    def test_real_stdout_and_stderr_overflow(self):
        for stream in ('stdout','stderr'):
            with self.subTest(stream=stream):
                self.refuse("import sys,signal;signal.signal(signal.SIGTERM,signal.SIG_IGN);sys."+stream+".write('x'*2097152);sys."+stream+".flush()",'native_capture_limit')
    def test_byte_bound_not_character_bound(self):
        self.refuse("import sys;sys.stdout.buffer.write(bytes([195,169])*40000)",'native_capture_limit')
    def test_backpressure_both_streams(self):
        self.refuse("import os;\nfor i in range(1000):\n os.write(1,b'x'*8192);os.write(2,b'y'*8192)",'native_capture_limit')
    def test_timeout_partial_and_total_deadline(self):
        n=self.refuse("import os,time;os.write(1,b'partial');time.sleep(30)",'native_timeout',1.4)
        self.assertEqual(n.last_observation['stdout_bytes'],7)
        self.assertLess(n.last_observation['duration_seconds'],1.6)
    def test_selector_exception_still_reaps_owned_child(self):
        n,a=self.invoke("import time;time.sleep(30)")
        with patch.object(m.selectors,'DefaultSelector',side_effect=OSError('private sentinel')):
            with self.assertRaisesRegex(m.Refusal,'^native_capture_unknown$'):n.call(a)
        self.assertTrue(n.last_observation['leader_reaped'])
    def test_signal_permission_error_is_unknown_not_success(self):
        n,a=self.invoke("import os,time;os.write(1,b'OK');time.sleep(30)",1.4)
        with patch.object(m.os,'killpg',side_effect=PermissionError('private sentinel')):
            with self.assertRaisesRegex(m.Refusal,'^native_cleanup_unknown$'):n.call(a)
        self.assertTrue(n.last_observation['leader_reaped'])
        self.assertEqual(n.last_observation['cleanup'],'NOT_MEASURED')
    def test_insufficient_cleanup_reserve_does_not_spawn(self):
        n,a=self.invoke("raise Exception('must not spawn')",.9)
        with patch.object(m.subprocess,'Popen') as popen:
            with self.assertRaisesRegex(m.Refusal,'^deadline$'):n.call(a)
            popen.assert_not_called()
    def test_group_descendant_after_leader_exit(self):
        # Test process becomes a subreaper solely for its own known child recovery.
        self.assertEqual(ctypes.CDLL(None).prctl(36,1,0,0,0),0)
        with tempfile.TemporaryDirectory() as d:
            f=Path(d)/'pid'
            n,a=self.invoke("import os,time,pathlib; p=os.fork();\nif p==0:\n time.sleep(30)\nelse:\n pathlib.Path("+repr(str(f))+").write_text(str(p));os._exit(0)")
            self.assertEqual(n.call(a),'')
            pid=int(f.read_text()); waited,status=os.waitpid(pid,0)
            self.assertEqual(waited,pid);self.assertTrue(os.WIFSIGNALED(status))
    def test_escaped_child_keeps_pipe_incomplete_and_requires_proof_parent_recovery(self):
        self.assertEqual(ctypes.CDLL(None).prctl(36,1,0,0,0),0)
        with tempfile.TemporaryDirectory() as d:
            f=Path(d)/'pid';pid=None
            n,a=self.invoke("import os,time,pathlib; p=os.fork();\nif p==0:\n os.setsid();pathlib.Path("+repr(str(f))+").write_text(str(os.getpid()));time.sleep(30)\nelse:\n time.sleep(.1);os._exit(0)",1.4)
            try:
                with self.assertRaisesRegex(m.Refusal,'^native_capture_incomplete$'):n.call(a)
                pid=int(f.read_text())
                self.assertEqual(n.last_observation['escaped_descendants'],'NOT_MEASURED')
                self.assertFalse(n.last_observation['capture_complete'])
            finally:
                if pid is None and f.exists():pid=int(f.read_text())
                if pid is not None:os.kill(pid,signal.SIGKILL);os.waitpid(pid,0)

if __name__=='__main__':unittest.main()
