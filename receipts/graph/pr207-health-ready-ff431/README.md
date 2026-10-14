# PR207 health readiness HTTP canary

The canonical CanaryResult files exercise the compiled `HealthController` over loopback HTTP at source commit `ff4311405175dd38aee216a8cf36a969f62dc9c1`. They cover the required DeepSeek provider in `unavailable` and `ready` states with database readiness injected as healthy; both responses are HTTP 200, with `degraded` and `ok` bodies respectively. Provider egress is disabled.

The independent negative control uses the previous source `6decc98afe171c75a470f4af83f1457c0388681c` and the same unavailable state; it returns HTTP 503 with body status `error`. This confirms the changed readiness behavior.

This is a controller-bound HTTP canary, not a full application runtime, deployment, or live-provider check. The exact-head ChangeAdmissionReceipt is the separate graph-admission measurement.
