# @testchimp/k6

k6 `handleSummary` reporter for TestChimp performance runs. k6-compatible ESM — uses `k6/http` and `__ENV`, not Node `axios`.

## Usage

```js
import { handleSummary } from 'https://cdn.jsdelivr.net/npm/@testchimp/k6@0.2.0/handleSummary.js';
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
| `TESTCHIMP_PERF_RUN_ID_FILE` | Optional path; on successful ingest, `handleSummary` writes `runId` here (k6 file-return) |

## Timeseries (optional)

k6 JS **cannot** sample live p95 in `handleSummary`. Charts need
`k6 run --out json=…` **plus** a Node downsample attached to the ingest
`runId` (sidecar `TESTCHIMP_PERF_RUN_ID_FILE`, or `runId=` on stdout).

**Prefer the TestChimp skill wrapper** (`k6/scripts/run-journey.sh`): it already
passes `--out json`, writes the sidecar, downsamples, and POSTs
`/api/ingest_perf_run_timeseries`. Do not add a second `--out json`. Do not
look up “latest run by test id.”

Manual / library use (Node only — `downsample.js` uses `fs`):

```js
import {
  downsampleK6JsonMetrics,
  buildTimeseriesAttachBody,
  attachTimeseriesUrl,
  postTimeseriesAttach,
} from '@testchimp/k6/downsample';
import fs from 'node:fs';

const runId = fs.readFileSync(process.env.TESTCHIMP_PERF_RUN_ID_FILE, 'utf8').trim();
const result = downsampleK6JsonMetrics('metrics.json', {
  intervalSec: Number(process.env.TESTCHIMP_PERF_TIMESERIES_INTERVAL_SEC) || 5,
  maxPoints: 500,
});
await postTimeseriesAttach(process.env, runId, result);
// or: POST buildTimeseriesAttachBody(runId, result) to attachTimeseriesUrl(process.env)
```

`handleSummary` prints `runId=…` on successful ingest for debugging.

## Publish / delivery

1. Bump `version` in `package.json`, commit, push.
2. `npm publish --access public` (no build step — ships `handleSummary.js` + `ingest.js` + `downsample.js`).
3. User projects pick it up automatically: `k6/scripts/prepare.sh` (and every
   `run-journey.sh`) downloads **npm `latest`** into gitignored `k6/lib/`.

Optional overrides in a project:

```bash
# dogfood an unpublished checkout
K6_REPORTER_LOCAL_DIR=/path/to/k6-testchimp-reporter k6/scripts/prepare.sh

# pin a specific release (CI reproducibility)
K6_REPORTER_VERSION=0.2.0 k6/scripts/prepare.sh

# reuse already-downloaded lib (offline / airgapped)
K6_REPORTER_SKIP_REFRESH=1 k6/scripts/prepare.sh
```

Do **not** vendor reporter files into the app repo.
