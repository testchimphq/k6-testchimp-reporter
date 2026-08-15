/**
 * Downsample k6 `--out json` metric points into a compact timeseries for TestChimp.
 * Every metric k6 emits (built-in and custom) is bucketed by name — not a thin subset.
 * Aggregation is by metric name only (tags are folded). Node-safe (no k6 imports).
 * Call from CI/scripts after the run, not from handleSummary.
 *
 * File paths are streamed (two passes) so large k6 JSON dumps are not loaded whole.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { attachTimeseriesUrl } from './ingest.js';

export { attachTimeseriesUrl };

const DEFAULT_INTERVAL_SEC = 5;
const DEFAULT_MAX_POINTS = 500;
const DEFAULT_ATTACH_TIMEOUT_MS = 15_000;
const FILE_READ_CHUNK = 64 * 1024;

function loadRaw(jsonPathOrContent) {
  if (Array.isArray(jsonPathOrContent)) {
    return JSON.stringify(jsonPathOrContent);
  }
  if (typeof jsonPathOrContent !== 'string') {
    return '';
  }
  const trimmed = jsonPathOrContent.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return jsonPathOrContent;
  }
  try {
    if (fs.existsSync(jsonPathOrContent)) {
      return fs.readFileSync(jsonPathOrContent, 'utf8');
    }
  } catch {
    // treat as content below
  }
  return jsonPathOrContent;
}

function parseRecords(jsonPathOrContent) {
  const raw = loadRaw(jsonPathOrContent).trim();
  if (!raw) return [];

  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      records.push(JSON.parse(s));
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

function parseTimeMs(data) {
  if (!data) return NaN;
  if (typeof data.time === 'string') {
    const ms = Date.parse(data.time);
    return Number.isFinite(ms) ? ms : NaN;
  }
  if (typeof data.time === 'number') return data.time;
  return NaN;
}

/** Nearest-rank: sort ascending, pick index ceil(p/100 * n) - 1 */
function percentileApprox(sorted, p) {
  if (!sorted.length) return undefined;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function mean(values) {
  if (!values.length) return undefined;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Detect pass/fail from common k6 tags on http_req_failed samples.
 * Returns true/false when known, null when unknown.
 */
function failedFromTags(tags) {
  if (!tags || typeof tags !== 'object') return null;
  const er = tags.expected_response;
  if (er === 'false' || er === false) return true;
  if (er === 'true' || er === true) return false;
  return null;
}

/** Status-class series folded into http_req_failed (not 2xx — that is success). */
const STATUS_CLASSES = ['0xx', '3xx', '4xx', '5xx'];

/**
 * Map k6 `tags.status` (string or number) to a response-class bucket.
 * 0 / missing / 1xx / 6xx+ → 0xx (no HTTP response or other).
 * Returns null when the tag is absent so untagged dumps stay unchanged.
 */
function parseStatusClass(tags) {
  if (!tags || typeof tags !== 'object') return null;
  const raw = tags.status;
  if (raw == null || raw === '') return null;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return null;
  if (n < 100) return '0xx';
  const hundred = Math.floor(n / 100);
  if (hundred === 2) return '2xx';
  if (hundred === 3) return '3xx';
  if (hundred === 4) return '4xx';
  if (hundred === 5) return '5xx';
  return '0xx';
}

function statusClassWeight(sample) {
  if (sample.metric === 'http_reqs' && Number.isFinite(sample.value) && sample.value > 0) {
    return sample.value;
  }
  return 1;
}

function emptyStatusClassCounts() {
  return { '0xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
}

function isExistingFilePath(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
  try {
    return fs.existsSync(trimmed) && fs.statSync(trimmed).isFile();
  } catch {
    return false;
  }
}

function peekFirstNonWhitespace(path) {
  const fd = fs.openSync(path, 'r');
  try {
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const s = buf.toString('utf8', 0, n);
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t') return c;
    }
    return '';
  } finally {
    fs.closeSync(fd);
  }
}

function forEachNdjsonLine(path, fn) {
  const fd = fs.openSync(path, 'r');
  try {
    const buf = Buffer.alloc(FILE_READ_CHUNK);
    let leftover = '';
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      leftover += buf.toString('utf8', 0, bytesRead);
      let nl;
      while ((nl = leftover.search(/\r?\n/)) !== -1) {
        const crlf = leftover[nl] === '\r' && leftover[nl + 1] === '\n';
        const line = leftover.slice(0, nl);
        leftover = leftover.slice(nl + (crlf ? 2 : 1));
        fn(line);
      }
    }
    if (leftover) fn(leftover);
  } finally {
    fs.closeSync(fd);
  }
}

/** k6 built-in metric types when a Metric record is missing. */
const KNOWN_TYPES = {
  checks: 'rate',
  data_received: 'counter',
  data_sent: 'counter',
  dropped_iterations: 'counter',
  group_duration: 'trend',
  http_req_blocked: 'trend',
  http_req_connecting: 'trend',
  http_req_duration: 'trend',
  http_req_failed: 'rate',
  http_req_receiving: 'trend',
  http_req_sending: 'trend',
  http_req_tls_handshaking: 'trend',
  http_req_waiting: 'trend',
  http_reqs: 'counter',
  iteration_duration: 'trend',
  iterations: 'counter',
  vus: 'gauge',
  vus_max: 'gauge',
};

const VALID_TYPES = new Set(['trend', 'counter', 'gauge', 'rate']);
const TREND_STATS = ['min', 'avg', 'med', 'p90', 'p95', 'max'];

function metricTypeFromRecord(rec) {
  if (!rec || rec.type !== 'Metric' || !rec.metric) return null;
  const type = String(rec.data?.type || '').toLowerCase();
  if (!VALID_TYPES.has(type)) return null;
  return { name: String(rec.metric), type };
}

function resolveMetricType(name, metricTypes) {
  const fromRecord = metricTypes && metricTypes.get(name);
  if (fromRecord && VALID_TYPES.has(fromRecord)) return fromRecord;
  return KNOWN_TYPES[name] || 'trend';
}

function seriesKeysForType(name, type, statusClassesSeen) {
  let keys;
  switch (type) {
    case 'gauge':
      keys = [name];
      break;
    case 'counter':
      keys = [`${name}.count`, `${name}.rate`];
      break;
    case 'rate':
      keys = [`${name}.rate`];
      break;
    default:
      keys = TREND_STATS.map((stat) => `${name}.${stat}`);
  }
  if (name === 'http_req_failed' && statusClassesSeen && statusClassesSeen.size) {
    for (const cls of STATUS_CLASSES) {
      keys.push(`http_req_failed.${cls}.rate`);
    }
  }
  return keys;
}

function buildCatalog(metricTypes, seenNames, statusClassesSeen) {
  return [...seenNames].sort().map((name) => {
    const type = resolveMetricType(name, metricTypes);
    return { name, type, keys: seriesKeysForType(name, type, statusClassesSeen) };
  });
}

function sampleFromRecord(rec) {
  if (!rec || rec.type === 'Metric') return null;
  if (rec.type !== 'Point' || !rec.metric || !rec.data) return null;
  const t = parseTimeMs(rec.data);
  const value = Number(rec.data.value);
  if (!Number.isFinite(t) || !Number.isFinite(value)) return null;
  return { t, metric: String(rec.metric), value, tags: rec.data.tags };
}

function forEachFileRecord(path, fn) {
  forEachNdjsonLine(path, (line) => {
    const s = line.trim();
    if (!s) return;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch {
      return;
    }
    fn(rec);
  });
}

function resolveInterval(intervalSec, maxPoints, t0, tLast) {
  const spanMs = Math.max(0, tLast - t0);
  const neededBuckets = Math.floor(spanMs / (intervalSec * 1000)) + 1;
  if (neededBuckets > maxPoints) {
    return Math.max(1, Math.ceil(spanMs / (maxPoints * 1000)));
  }
  return intervalSec;
}

function emptyAccum(type) {
  return {
    type,
    values: [],
    sum: 0,
    last: undefined,
    failCount: 0,
    passCount: 0,
    usedBoolTags: false,
    statusClass: emptyStatusClassCounts(),
    statusTagged: 0,
  };
}

function recordStatusClass(a, sample) {
  if (sample.metric !== 'http_req_failed' && sample.metric !== 'http_reqs') return false;
  const cls = parseStatusClass(sample.tags);
  if (!cls) return false;
  const n = statusClassWeight(sample);
  a.statusTagged += n;
  if (a.statusClass[cls] != null) a.statusClass[cls] += n;
  return true;
}

function addSample(buckets, sample, t0, intervalMs, metricTypes, statusClassesSeen) {
  const idx = Math.max(0, Math.floor((sample.t - t0) / intervalMs));
  let bucket = buckets.get(idx);
  if (!bucket) {
    bucket = new Map();
    buckets.set(idx, bucket);
  }
  const type = resolveMetricType(sample.metric, metricTypes);
  let a = bucket.get(sample.metric);
  if (!a) {
    a = emptyAccum(type);
    bucket.set(sample.metric, a);
  }
  a.last = sample.value;
  a.sum += sample.value;
  if (recordStatusClass(a, sample) && statusClassesSeen) {
    statusClassesSeen.add('tagged');
  }
  if (type === 'rate' && sample.metric === 'http_req_failed') {
    const tagFail = failedFromTags(sample.tags);
    if (tagFail === true || tagFail === false) {
      a.usedBoolTags = true;
      if (tagFail) a.failCount += 1;
      else a.passCount += 1;
    } else {
      a.values.push(sample.value);
    }
    return;
  }
  if (type === 'trend' || type === 'rate') {
    a.values.push(sample.value);
  }
}

function applyStatusClassRates(row, a) {
  if (!a || !(a.statusTagged > 0)) return;
  const denom = a.statusTagged;
  for (const cls of STATUS_CLASSES) {
    row[`http_req_failed.${cls}.rate`] = (a.statusClass[cls] || 0) / denom;
  }
}

function flattenAccum(row, name, a, intervalSec, sibling) {
  const type = a.type;
  if (type === 'gauge') {
    if (a.last != null) row[name] = a.last;
    return;
  }
  if (type === 'counter') {
    row[`${name}.count`] = a.sum;
    row[`${name}.rate`] = a.sum / intervalSec;
    return;
  }
  if (type === 'rate') {
    if (name === 'http_req_failed' && a.usedBoolTags && a.failCount + a.passCount > 0) {
      row[`${name}.rate`] = a.failCount / (a.failCount + a.passCount);
    } else if (a.values.length) {
      row[`${name}.rate`] = mean(a.values);
    }
    if (name === 'http_req_failed') {
      const src = a.statusTagged > 0 ? a : sibling && sibling.get('http_reqs');
      applyStatusClassRates(row, src);
    }
    return;
  }
  if (!a.values.length) return;
  const sorted = a.values.slice().sort((x, y) => x - y);
  row[`${name}.min`] = sorted[0];
  row[`${name}.avg`] = mean(sorted);
  row[`${name}.med`] = percentileApprox(sorted, 50);
  row[`${name}.p90`] = percentileApprox(sorted, 90);
  row[`${name}.p95`] = percentileApprox(sorted, 95);
  row[`${name}.max`] = sorted[sorted.length - 1];
}

function applyV1Aliases(row) {
  if (row['http_req_duration.p95'] != null) row.http_req_duration_p95 = row['http_req_duration.p95'];
  if (row['http_req_duration.avg'] != null) row.http_req_duration_avg = row['http_req_duration.avg'];
  if (row['http_req_failed.rate'] != null) row.http_req_failed_rate = row['http_req_failed.rate'];
  if (row['http_reqs.rate'] != null) row.http_reqs_rate = row['http_reqs.rate'];
}

function pointsFromBuckets(buckets, t0, intervalSec) {
  const intervalMs = intervalSec * 1000;
  const indices = [...buckets.keys()].sort((a, b) => a - b);
  const points = [];
  for (const idx of indices) {
    const bucket = buckets.get(idx);
    const row = { t_ms: t0 + idx * intervalMs };
    const names = [...bucket.keys()].sort();
    for (const name of names) {
      flattenAccum(row, name, bucket.get(name), intervalSec, bucket);
    }
    if (
      row['http_req_failed.0xx.rate'] == null
      && row['http_req_failed.3xx.rate'] == null
      && row['http_req_failed.4xx.rate'] == null
      && row['http_req_failed.5xx.rate'] == null
    ) {
      applyStatusClassRates(row, bucket.get('http_reqs'));
    }
    applyV1Aliases(row);
    points.push(row);
  }
  return points;
}

function emptyResult(intervalSec) {
  return { version: 2, intervalSec, points: [], metrics: [] };
}

function downsampleSamples(samples, intervalSec, maxPoints, metricTypes) {
  if (!samples.length) {
    return emptyResult(intervalSec);
  }
  metricTypes = metricTypes || new Map();
  samples.sort((a, b) => a.t - b.t);
  const t0 = samples[0].t;
  intervalSec = resolveInterval(intervalSec, maxPoints, t0, samples[samples.length - 1].t);
  const intervalMs = intervalSec * 1000;
  const buckets = new Map();
  const seen = new Set();
  const statusClassesSeen = new Set();
  for (const sample of samples) {
    seen.add(sample.metric);
    addSample(buckets, sample, t0, intervalMs, metricTypes, statusClassesSeen);
  }
  return {
    version: 2,
    intervalSec,
    points: pointsFromBuckets(buckets, t0, intervalSec),
    metrics: buildCatalog(metricTypes, seen, statusClassesSeen),
  };
}

function collectFromRecords(records) {
  const metricTypes = new Map();
  const samples = [];
  for (const rec of records) {
    const mt = metricTypeFromRecord(rec);
    if (mt) metricTypes.set(mt.name, mt.type);
    const sample = sampleFromRecord(rec);
    if (sample) samples.push(sample);
  }
  return { samples, metricTypes };
}

function downsampleNdjsonFile(path, intervalSec, maxPoints) {
  const metricTypes = new Map();
  let t0 = null;
  let tLast = null;
  forEachFileRecord(path, (rec) => {
    const mt = metricTypeFromRecord(rec);
    if (mt) metricTypes.set(mt.name, mt.type);
    const sample = sampleFromRecord(rec);
    if (!sample) return;
    if (t0 == null || sample.t < t0) t0 = sample.t;
    if (tLast == null || sample.t > tLast) tLast = sample.t;
  });
  if (t0 == null) {
    return emptyResult(intervalSec);
  }
  intervalSec = resolveInterval(intervalSec, maxPoints, t0, tLast);
  const intervalMs = intervalSec * 1000;
  const buckets = new Map();
  const seen = new Set();
  const statusClassesSeen = new Set();
  forEachFileRecord(path, (rec) => {
    const sample = sampleFromRecord(rec);
    if (!sample) return;
    seen.add(sample.metric);
    addSample(buckets, sample, t0, intervalMs, metricTypes, statusClassesSeen);
  });
  return {
    version: 2,
    intervalSec,
    points: pointsFromBuckets(buckets, t0, intervalSec),
    metrics: buildCatalog(metricTypes, seen, statusClassesSeen),
  };
}

/**
 * @param {string|object[]} jsonPathOrContent - path to k6 JSON output, NDJSON/JSON string, or parsed array
 * @param {{ intervalSec?: number, maxPoints?: number }} [options]
 * @returns {{ version: number, intervalSec: number, points: Array<object>, metrics: Array<object> }}
 */
export function downsampleK6JsonMetrics(jsonPathOrContent, options) {
  const opts = options || {};
  let intervalSec = Number(opts.intervalSec);
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) intervalSec = DEFAULT_INTERVAL_SEC;
  let maxPoints = Number(opts.maxPoints);
  if (!Number.isFinite(maxPoints) || maxPoints <= 0) maxPoints = DEFAULT_MAX_POINTS;

  if (isExistingFilePath(jsonPathOrContent)) {
    if (peekFirstNonWhitespace(jsonPathOrContent) === '[') {
      const { samples, metricTypes } = collectFromRecords(parseRecords(jsonPathOrContent));
      return downsampleSamples(samples, intervalSec, maxPoints, metricTypes);
    }
    return downsampleNdjsonFile(jsonPathOrContent, intervalSec, maxPoints);
  }

  const { samples, metricTypes } = collectFromRecords(parseRecords(jsonPathOrContent));
  return downsampleSamples(samples, intervalSec, maxPoints, metricTypes);
}

/**
 * Body for POST /api/ingest_perf_run_timeseries (protobuf JSON camelCase).
 * `points` may be an array or the `{ version, intervalSec, points, metrics }` result from downsampleK6JsonMetrics.
 */
export function buildTimeseriesAttachBody(runId, points, intervalSec) {
  let pts;
  let sec = intervalSec;
  let version = 1;
  let metrics;
  if (points && !Array.isArray(points) && Array.isArray(points.points)) {
    pts = points.points;
    if (sec == null) sec = points.intervalSec;
    if (points.version != null) version = points.version;
    if (Array.isArray(points.metrics)) metrics = points.metrics;
  } else {
    pts = Array.isArray(points) ? points : [];
  }
  if (!Number.isFinite(Number(sec)) || Number(sec) <= 0) {
    sec = DEFAULT_INTERVAL_SEC;
  } else {
    sec = Number(sec);
  }
  const payload = {
    version,
    intervalSec: sec,
    points: pts,
  };
  if (metrics) payload.metrics = metrics;
  return {
    runId: String(runId || ''),
    timeseriesJson: JSON.stringify(payload),
  };
}

/**
 * POST a downsampled timeseries. Never throws — callers keep the k6 exit code.
 * @returns {Promise<{ attached: boolean, reason?: string, statusCode?: number, body?: string }>}
 */
export function postTimeseriesAttach(env, runId, downsampleResult, options) {
  const points = downsampleResult && Array.isArray(downsampleResult.points)
    ? downsampleResult.points
    : [];
  if (!points.length) {
    return Promise.resolve({ attached: false, reason: 'no-points' });
  }
  const timeoutMs = Number(options && options.timeoutMs) || DEFAULT_ATTACH_TIMEOUT_MS;
  const body = JSON.stringify(buildTimeseriesAttachBody(runId, downsampleResult));
  const url = new URL(attachTimeseriesUrl(env));
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'testchimp-api-key': (env && env.TESTCHIMP_API_KEY) || '',
          'Project-Id': (env && env.TESTCHIMP_PROJECT_ID) || '',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          resolve({
            attached: ok,
            statusCode: res.statusCode,
            body: data,
            reason: ok ? undefined : `http-${res.statusCode}`,
          });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ attached: false, reason: 'timeout' });
    });
    req.on('error', (err) => {
      resolve({ attached: false, reason: err.message || 'network-error' });
    });
    req.write(body);
    req.end();
  });
}
