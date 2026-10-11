import copy
import importlib.util
import json
from pathlib import Path
import unittest

root=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('candidate',root/'prime-candidate-receiving.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class CandidateReceivingTests(unittest.TestCase):
    def setUp(self):
        self.record=json.loads((root/'prime-candidate-receiving.fixture.json').read_text())
    def check(self,r):
        return m.check(r,self.record['sourceRevision'],self.record['imageId'])
    def test_actual_projection_is_process_only(self):
        result=self.check(self.record)
        self.assertFalse(result['deployment_authorized'])
        self.assertEqual(result['production_readiness'],'NOT_MEASURED')
        self.assertIsNone(result['registryImage'])
    def test_independent_negative_controls(self):
        changes=[
            lambda r:r.update(sourceRevision='0'*40),
            lambda r:r.update(imageId='sha256:'+'0'*64),
            lambda r:r.update(runtime_authorized=True),
            lambda r:r['imageInspect']['Config']['Labels'].update({'org.opencontainers.image.revision':'0'*40}),
            lambda r:r['imageInspect']['Config']['Env'].append('PRIVATE_TOKEN=synthetic'),
            lambda r:r['containerInspect']['HostConfig'].update(NetworkMode='host'),
            lambda r:r['containerInspect']['HostConfig'].update(PortBindings={'8080/tcp':[{'HostIp':'0.0.0.0','HostPort':'8080'}]}),
            lambda r:r['containerInspect']['HostConfig'].update(Privileged=True),
            lambda r:r['http'][0]['body'].update(version='0'*40),
            lambda r:r['http'][1].update(status=200),
            lambda r:r['http'][0]['body'].update(runtime_authorized=0),
            lambda r:r.update(containerTeardown='NOT_MEASURED'),
        ]
        for i,change in enumerate(changes):
            with self.subTest(control=i):
                r=copy.deepcopy(self.record);change(r)
                with self.assertRaises(m.Refusal):self.check(r)

if __name__=='__main__':unittest.main()
