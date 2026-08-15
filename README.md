# @testchimp/k6

k6 `handleSummary` reporter for TestChimp performance runs. k6-compatible ESM — uses `k6/http` and `__ENV`, not Node `axios`.

## Usage

```js
import { handleSummary } from 'https://cdn.jsdelivr.net/npm/@testchimp/k6@0.1.0/handleSummary.js';
export { handleSummary };

export const testchimp = {
  id: 'checkout-journey',
  kind: 'journey',
  scenarios: ['#TS-101'],
  testTypes: ['load'],
};

export default function () {
  // ...
}
```

k6 cannot read sibling `export const testchimp` from `handleSummary`. Pass the same fields via env (the `k6/scripts/run-journey.sh` wrapper does this):

| Env | Purpose |
|-----|---------|
| `TESTCHIMP_API_KEY` | API key (required) |
| `TESTCHIMP_PROJECT_ID` | Project id (required) |
| `TESTCHIMP_INGRESS_URL` | Ingest host (optional; SaaS `TESTCHIMP_BACKEND_URL` is rewritten featureservice→ingress) |
| `TESTCHIMP_PERF_ID` | `testchimp.id` |
| `TESTCHIMP_PERF_KIND` | `journey` or `composite` |
| `TESTCHIMP_PERF_TEST_TYPES` | comma-separated `load`,`volume` |
| `TESTCHIMP_PERF_SCENARIOS` | comma-separated scenario titles |
| `TESTCHIMP_PERF_MEMBERS` | comma-separated member `testchimp.id`s (composites) |
| `TESTCHIMP_FOLDER_PATH` / `TESTCHIMP_FILE_NAME` | Path under SmartTests root (required to ingest) |
| `TESTCHIMP_BRANCH_NAME` | Git branch (or `GITHUB_REF_NAME`) |
| `TESTCHIMP_PERF_META` | Optional JSON blob of the `testchimp` object |

Until the package is on jsDelivr, pin a local checkout:

```bash
K6_REPORTER_LOCAL_DIR=/path/to/k6-testchimp-reporter k6/scripts/prepare.sh
```

Do **not** vendor this file into the repo. Pin the version in `k6/scripts/prepare.sh`.
