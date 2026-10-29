"""Run the ArmEvidence cases against the AUP gate (read-only use of a checkout).

usage: graph-full-suite-arms-gate-controls.py <path to tools/graph of the AUP checkout>
Not a maintained suite member: it needs an AUP checkout, which CI does not have."""
from pathlib import Path
import importlib.util
import sys
import unittest

tools = Path(sys.argv.pop(1)).resolve()
sys.path.insert(0, str(tools))
import impact  # noqa: E402
import impact_pair  # noqa: E402

here = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('full_suite_tests', here / 'graph-full-suite.test.py')
tests = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tests)


class GateArmEvidence(tests.ArmEvidence):
    def gate(self, evidence):
        shipped = {k: v for k, v in evidence.items() if k != 'notes'}
        doc = {'admission': {'verdict': 'admitted_with_exemptions'},
               'change_set': {'head': self.head, 'base': self.base},
               'verdicts': [{'entity': self.UNIT, 'verdict': 'verified', 'verifier_ids': ['v']}],
               'verifiers': [{'id': 'v', 'kind': 'targeted_test', 'scope': 'global_fallback_full_suite',
                              'entities': [self.UNIT], 'exit_code': 0, 'output_ref': 'o',
                              'entity_verdicts': {self.UNIT: 'verified'}, 'arms': shipped}]}
        return impact_pair.fallback_arm_problems(impact.Repo(self.root), self.base, self.head, doc, {self.UNIT}, self.base)


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(GateArmEvidence)
    sys.exit(0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1)
