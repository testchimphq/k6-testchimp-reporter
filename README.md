# @testchimp/k6

k6 `handleSummary` reporter for TestChimp performance runs. k6-compatible ESM — uses `k6/http` and `__ENV`, not Node `axios`.

## Usage

```js
import { handleSummary } from 'https://cdn.jsdelivr.net/npm/@testchimp/k6@latest/handleSummary.js';
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
| `TESTCHIMP_BATCH_INVOCATION_ID` | Suite batch id. Prefer the `k6/scripts/run.sh` wrapper, which mints one id for the whole suite. If unset, the reporter generates a UUID (one per `k6 run`). |
| `TESTCHIMP_PERF_META` | Optional JSON blob of the `testchimp` object |
| `TESTCHIMP_PERF_RUN_ID_FILE` | Optional path; on successful ingest, `handleSummary` writes `runId` here (k6 file-return) |
| `TESTCHIMP_SKIP_SUITE_BATCH_COMPLETE` | Set to `1` to skip suite-end `complete_perf_batch_invocation` (when not using `k6/scripts/run.sh`) |

Suite-end batch completion: `k6/scripts/run.sh` calls `POST /api/complete_perf_batch_invocation` once after all journeys (requires the same `TESTCHIMP_BATCH_INVOCATION_ID`). Library helper: `postCompletePerfBatch(process.env)` from `./ingest.js`.

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

Downsample is **not** a thin subset. Every metric in the k6 JSON dump is bucketed
by **metric name** (tags folded together):

| k6 type | Series on each point |
|---------|----------------------|
| trend | `{name}.min`, `.avg`, `.med`, `.p90`, `.p95`, `.max` |
| rate | `{name}.rate` |
| counter | `{name}.count`, `{name}.rate` (per second) |
| gauge | `{name}` (last value in the bucket) |

Custom metrics (e.g. `Trend('checkout_wait')`) are included the same way.
`volume_size` is a **known gauge** (≥ **0.2.3**) so volume charts plot last
value even when the dump omits a Metric record.
Timeseries JSON is **version 2** and includes a `metrics` catalog. v1 aliases
(`http_req_duration_p95`, `http_req_failed_rate`, `http_reqs_rate`) are still
written so older Executions charts keep working. Metric records in the k6 dump
set types; a name with no Metric record uses a built-in map, else **trend**.

`http_req_failed` keeps k6’s combined fail rate **and**, when `tags.status` is
present on `http_req_failed` / `http_reqs` samples, per-class rates as a
fraction of tagged requests:

| Series | Meaning |
|--------|---------|
| `http_req_failed.rate` | Any failure (k6 `http_req_failed`, typically 4xx/5xx/status 0) |
| `http_req_failed.5xx.rate` | Share of requests with HTTP 5xx |
| `http_req_failed.4xx.rate` | Share of requests with HTTP 4xx |
| `http_req_failed.3xx.rate` | Share of requests with HTTP 3xx |
| `http_req_failed.0xx.rate` | No HTTP status (network / timeout / status 0) |

Untagged dumps omit the class keys so older charts stay unchanged.

Ingest merges timeseries into the run `summary_json` (cap **2,000,000**
characters). Typical HTTP scripts stay well under that; browser-module dumps
with many custom trends can get close — attach already fails open (k6 exit
code is unchanged).

## Publish / delivery

1. Bump `version` in `package.json`, commit, push.
2. `npm publish --access public` (no build step — ships `handleSummary.js` + `ingest.js` + `downsample.js`).
3. User projects pick it up automatically: `k6/scripts/prepare.sh` (and every
   `run-journey.sh`) always downloads **npm `latest`** into gitignored
   `k6/lib/`. The TestChimp skill **ignores** `K6_REPORTER_VERSION`.

Optional overrides in a project:

```bash
# dogfood an unpublished checkout
K6_REPORTER_LOCAL_DIR=/path/to/k6-testchimp-reporter k6/scripts/prepare.sh

# reuse already-downloaded lib (offline / airgapped)
K6_REPORTER_SKIP_REFRESH=1 k6/scripts/prepare.sh
```

Do **not** vendor reporter files into the app repo.
