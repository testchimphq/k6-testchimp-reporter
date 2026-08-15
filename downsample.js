/**
 * Downsample k6 `--out json` metric points into a compact timeseries for TestChimp.
 * Node-safe (no k6 imports). Call from CI/scripts after the run, not from handleSummary.
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

function sampleFromRecord(rec) {
  if (!rec || rec.type === 'Metric') return null;
  if (rec.type !== 'Point' || !rec.metric || !rec.data) return null;
  const t = parseTimeMs(rec.data);
  const value = Number(rec.data.value);
  if (!Number.isFinite(t) || !Number.isFinite(value)) return null;
  return { t, metric: String(rec.metric), value, tags: rec.data.tags };
}

function forEachFileSample(path, fn) {
  forEachNdjsonLine(path, (line) => {
    const s = line.trim();
    if (!s) return;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch {
      return;
    }
    const sample = sampleFromRecord(rec);
    if (sample) fn(sample);
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

function emptyBucket() {
  return {
    durations: [],
    failedValues: [],
    failedCount: 0,
    passedCount: 0,
    usedBoolTags: false,
    vus: undefined,
    reqs: 0,
  };
}

function addSample(buckets, sample, t0, intervalMs) {
  const idx = Math.max(0, Math.floor((sample.t - t0) / intervalMs));
  let b = buckets.get(idx);
  if (!b) {
    b = emptyBucket();
    buckets.set(idx, b);
  }
  switch (sample.metric) {
    case 'http_req_duration':
      b.durations.push(sample.value);
      break;
    case 'vus':
      b.vus = sample.value;
      break;
    case 'http_reqs':
      b.reqs += sample.value;
      break;
    case 'http_req_failed': {
      const tagFail = failedFromTags(sample.tags);
      if (tagFail === true || tagFail === false) {
        b.usedBoolTags = true;
        if (tagFail) b.failedCount += 1;
        else b.passedCount += 1;
      } else {
        b.failedValues.push(sample.value);
      }
      break;
    }
    default:
      break;
  }
}

function pointsFromBuckets(buckets, t0, intervalSec) {
  const intervalMs = intervalSec * 1000;
  const indices = [...buckets.keys()].sort((a, b) => a - b);
  const points = [];
  for (const idx of indices) {
    const b = buckets.get(idx);
    const sorted = b.durations.slice().sort((a, c) => a - c);
    let http_req_failed_rate;
    if (b.usedBoolTags && b.failedCount + b.passedCount > 0) {
      http_req_failed_rate = b.failedCount / (b.failedCount + b.passedCount);
    } else if (b.failedValues.length) {
      http_req_failed_rate = mean(b.failedValues);
    }
    points.push({
      t_ms: t0 + idx * intervalMs,
      vus: b.vus,
      http_req_duration_p95: percentileApprox(sorted, 95),
      http_req_duration_avg: mean(sorted),
      http_req_failed_rate,
      http_reqs_rate: b.reqs / intervalSec,
    });
  }
  return points;
}

function downsampleSamples(samples, intervalSec, maxPoints) {
  if (!samples.length) {
    return { intervalSec, points: [] };
  }
  samples.sort((a, b) => a.t - b.t);
  const t0 = samples[0].t;
  intervalSec = resolveInterval(intervalSec, maxPoints, t0, samples[samples.length - 1].t);
  const intervalMs = intervalSec * 1000;
  const buckets = new Map();
  for (const sample of samples) {
    addSample(buckets, sample, t0, intervalMs);
  }
  return { intervalSec, points: pointsFromBuckets(buckets, t0, intervalSec) };
}

function downsampleNdjsonFile(path, intervalSec, maxPoints) {
  let t0 = null;
  let tLast = null;
  forEachFileSample(path, (sample) => {
    if (t0 == null || sample.t < t0) t0 = sample.t;
    if (tLast == null || sample.t > tLast) tLast = sample.t;
  });
  if (t0 == null) {
    return { intervalSec, points: [] };
  }
  intervalSec = resolveInterval(intervalSec, maxPoints, t0, tLast);
  const intervalMs = intervalSec * 1000;
  const buckets = new Map();
  forEachFileSample(path, (sample) => addSample(buckets, sample, t0, intervalMs));
  return { intervalSec, points: pointsFromBuckets(buckets, t0, intervalSec) };
}

/**
 * @param {string|object[]} jsonPathOrContent - path to k6 JSON output, NDJSON/JSON string, or parsed array
 * @param {{ intervalSec?: number, maxPoints?: number }} [options]
 * @returns {{ intervalSec: number, points: Array<object> }}
 */
export function downsampleK6JsonMetrics(jsonPathOrContent, options) {
  const opts = options || {};
  let intervalSec = Number(opts.intervalSec);
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) intervalSec = DEFAULT_INTERVAL_SEC;
  let maxPoints = Number(opts.maxPoints);
  if (!Number.isFinite(maxPoints) || maxPoints <= 0) maxPoints = DEFAULT_MAX_POINTS;

  if (isExistingFilePath(jsonPathOrContent)) {
    if (peekFirstNonWhitespace(jsonPathOrContent) === '[') {
      const samples = [];
      for (const rec of parseRecords(jsonPathOrContent)) {
        const sample = sampleFromRecord(rec);
        if (sample) samples.push(sample);
      }
      return downsampleSamples(samples, intervalSec, maxPoints);
    }
    return downsampleNdjsonFile(jsonPathOrContent, intervalSec, maxPoints);
  }

  const samples = [];
  for (const rec of parseRecords(jsonPathOrContent)) {
    const sample = sampleFromRecord(rec);
    if (sample) samples.push(sample);
  }
  return downsampleSamples(samples, intervalSec, maxPoints);
}

/**
 * Body for POST /api/ingest_perf_run_timeseries (protobuf JSON camelCase).
 * `points` may be an array or the `{ intervalSec, points }` result from downsampleK6JsonMetrics.
 */
export function buildTimeseriesAttachBody(runId, points, intervalSec) {
  let pts;
  let sec = intervalSec;
  if (points && !Array.isArray(points) && Array.isArray(points.points)) {
    pts = points.points;
    if (sec == null) sec = points.intervalSec;
  } else {
    pts = Array.isArray(points) ? points : [];
  }
  if (!Number.isFinite(Number(sec)) || Number(sec) <= 0) {
    sec = DEFAULT_INTERVAL_SEC;
  } else {
    sec = Number(sec);
  }
  return {
    runId: String(runId || ''),
    timeseriesJson: JSON.stringify({
      version: 1,
      intervalSec: sec,
      points: pts,
    }),
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
