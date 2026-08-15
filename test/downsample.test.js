import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  attachTimeseriesUrl,
  buildTimeseriesAttachBody,
  downsampleK6JsonMetrics,
} from '../downsample.js';
import { attachTimeseriesUrl as ingestAttachUrl } from '../ingest.js';

function ndjson(points) {
  return points.map((p) => JSON.stringify(p)).join('\n');
}

function point(metric, time, value, tags) {
  const data = { time, value };
  if (tags) data.tags = tags;
  return { type: 'Point', metric, data };
}

describe('downsampleK6JsonMetrics', () => {
  it('buckets NDJSON points and computes avg, p95, rates, last vus', () => {
    const t0 = '2024-01-01T00:00:00.000Z';
    const t1 = '2024-01-01T00:00:02.000Z';
    const t2 = '2024-01-01T00:00:04.000Z';
    const t3 = '2024-01-01T00:00:06.000Z'; // second bucket (interval 5s)

    const raw = ndjson([
      { type: 'Metric', metric: 'http_req_duration', data: { type: 'trend' } },
      point('vus', t0, 1),
      point('http_req_duration', t0, 100),
      point('http_req_duration', t1, 200),
      point('http_req_duration', t2, 300),
      point('http_req_failed', t0, 0),
      point('http_req_failed', t1, 1),
      point('http_reqs', t0, 1),
      point('http_reqs', t1, 1),
      point('http_reqs', t2, 1),
      point('vus', t2, 3),
      point('vus', t3, 5),
      point('http_req_duration', t3, 50),
      point('http_reqs', t3, 2),
      point('http_req_failed', t3, 0),
      { type: 'Metric', metric: 'iteration_duration', data: { type: 'trend' } },
      point('iteration_duration', t0, 10),
      point('iteration_duration', t1, 20),
      { type: 'Metric', metric: 'checks', data: { type: 'rate' } },
      point('checks', t0, 1),
      point('checks', t1, 0),
      { type: 'Metric', metric: 'data_received', data: { type: 'counter' } },
      point('data_received', t0, 100),
      { type: 'Metric', metric: 'errors', data: { type: 'counter' } },
      point('errors', t0, 2),
      { type: 'Metric', metric: 'custom_wait', data: { type: 'trend' } },
      point('custom_wait', t0, 5),
      point('custom_wait', t1, 15),
    ]);

    const { version, intervalSec, points, metrics } = downsampleK6JsonMetrics(raw, {
      intervalSec: 5,
      maxPoints: 500,
    });
    assert.equal(version, 2);
    assert.equal(intervalSec, 5);
    assert.equal(points.length, 2);

    const b0 = points[0];
    assert.equal(b0.t_ms, Date.parse(t0));
    assert.equal(b0.vus, 3);
    assert.equal(b0.http_req_duration_avg, 200);
    assert.equal(b0.http_req_duration_p95, 300);
    assert.equal(b0['http_req_duration.avg'], 200);
    assert.equal(b0['http_req_duration.p95'], 300);
    assert.equal(b0['http_req_duration.min'], 100);
    assert.equal(b0['http_req_duration.max'], 300);
    assert.equal(b0.http_req_failed_rate, 0.5);
    assert.equal(b0['http_req_failed.rate'], 0.5);
    assert.equal(b0.http_reqs_rate, 3 / 5);
    assert.equal(b0['http_reqs.count'], 3);
    assert.equal(b0['iteration_duration.avg'], 15);
    assert.equal(b0['checks.rate'], 0.5);
    assert.equal(b0['data_received.count'], 100);
    assert.equal(b0['errors.count'], 2);
    assert.equal(b0['custom_wait.p95'], 15);

    const b1 = points[1];
    assert.equal(b1.t_ms, Date.parse(t0) + 5000);
    assert.equal(b1.vus, 5);
    assert.equal(b1.http_req_duration_avg, 50);
    assert.equal(b1.http_reqs_rate, 2 / 5);

    const catalogNames = metrics.map((m) => m.name);
    assert.ok(catalogNames.includes('http_req_duration'));
    assert.ok(catalogNames.includes('custom_wait'));
    assert.ok(catalogNames.includes('errors'));
    const durationCat = metrics.find((m) => m.name === 'http_req_duration');
    assert.equal(durationCat.type, 'trend');
    assert.ok(durationCat.keys.includes('http_req_duration.p95'));
    const errorsCat = metrics.find((m) => m.name === 'errors');
    assert.equal(errorsCat.type, 'counter');
    assert.deepEqual(errorsCat.keys, ['errors.count', 'errors.rate']);
    const failedCat = metrics.find((m) => m.name === 'http_req_failed');
    assert.ok(failedCat);
    assert.deepEqual(failedCat.keys, ['http_req_failed.rate']);
    assert.equal(b0['http_req_failed.5xx.rate'], undefined);
  });

  it('computes failed rate from expected_response boolean tags', () => {
    const t0 = '2024-01-01T00:00:00.000Z';
    const raw = ndjson([
      point('http_req_failed', t0, 1, { expected_response: 'false' }),
      point('http_req_failed', t0, 0, { expected_response: 'true' }),
      point('http_req_failed', t0, 0, { expected_response: 'true' }),
    ]);
    const { points } = downsampleK6JsonMetrics(raw, { intervalSec: 5 });
    assert.equal(points.length, 1);
    assert.equal(points[0].http_req_failed_rate, 1 / 3);
    assert.equal(points[0]['http_req_failed.rate'], 1 / 3);
  });

  it('keeps response-class rates from http_req_failed status tags', () => {
    const t0 = '2024-01-01T00:00:00.000Z';
    const raw = ndjson([
      point('http_req_failed', t0, 0, { status: '200', expected_response: 'true' }),
      point('http_req_failed', t0, 0, { status: '200', expected_response: 'true' }),
      point('http_req_failed', t0, 0, { status: '301', expected_response: 'true' }),
      point('http_req_failed', t0, 1, { status: '404', expected_response: 'false' }),
      point('http_req_failed', t0, 1, { status: '503', expected_response: 'false' }),
      point('http_req_failed', t0, 1, { status: '0', expected_response: 'false' }),
    ]);
    const { points, metrics } = downsampleK6JsonMetrics(raw, { intervalSec: 5 });
    assert.equal(points.length, 1);
    assert.equal(points[0]['http_req_failed.rate'], 0.5);
    assert.equal(points[0]['http_req_failed.3xx.rate'], 1 / 6);
    assert.equal(points[0]['http_req_failed.4xx.rate'], 1 / 6);
    assert.equal(points[0]['http_req_failed.5xx.rate'], 1 / 6);
    assert.equal(points[0]['http_req_failed.0xx.rate'], 1 / 6);
    const failedCat = metrics.find((m) => m.name === 'http_req_failed');
    assert.ok(failedCat.keys.includes('http_req_failed.5xx.rate'));
    assert.ok(failedCat.keys.includes('http_req_failed.4xx.rate'));
    assert.ok(failedCat.keys.includes('http_req_failed.3xx.rate'));
    assert.ok(failedCat.keys.includes('http_req_failed.0xx.rate'));
  });

  it('derives status-class rates from http_reqs tags when failed samples are untagged', () => {
    const t0 = '2024-01-01T00:00:00.000Z';
    const raw = ndjson([
      point('http_req_failed', t0, 1),
      point('http_req_failed', t0, 0),
      point('http_reqs', t0, 1, { status: '500' }),
      point('http_reqs', t0, 1, { status: '200' }),
    ]);
    const { points } = downsampleK6JsonMetrics(raw, { intervalSec: 5 });
    assert.equal(points[0]['http_req_failed.5xx.rate'], 0.5);
    assert.equal(points[0]['http_req_failed.4xx.rate'], 0);
    assert.equal(points[0]['http_req_failed.3xx.rate'], 0);
    assert.equal(points[0]['http_req_failed.0xx.rate'], 0);
  });

  it('accepts a JSON array of points', () => {
    const arr = [
      point('vus', '2024-01-01T00:00:00.000Z', 2),
      point('http_reqs', '2024-01-01T00:00:01.000Z', 4),
    ];
    const { points } = downsampleK6JsonMetrics(JSON.stringify(arr), { intervalSec: 5 });
    assert.equal(points.length, 1);
    assert.equal(points[0].vus, 2);
    assert.equal(points[0].http_reqs_rate, 4 / 5);
  });

  it('increases interval to respect maxPoints', () => {
    const lines = [];
    const t0 = Date.parse('2024-01-01T00:00:00.000Z');
    // 60 seconds of samples every 1s → with intervalSec=1 would be 60 buckets; cap to 10
    for (let i = 0; i < 60; i++) {
      lines.push(point('vus', new Date(t0 + i * 1000).toISOString(), i + 1));
      lines.push(point('http_reqs', new Date(t0 + i * 1000).toISOString(), 1));
    }
    const { intervalSec, points } = downsampleK6JsonMetrics(ndjson(lines), {
      intervalSec: 1,
      maxPoints: 10,
    });
    assert.ok(intervalSec >= 6, `expected intervalSec>=6 got ${intervalSec}`);
    assert.ok(points.length <= 10, `expected <=10 points got ${points.length}`);
  });

  it('buckets NDJSON from a file without loading the whole string into parseRecords', () => {
    const t0 = '2024-01-01T00:00:00.000Z';
    const raw = ndjson([
      point('vus', t0, 2),
      point('http_reqs', t0, 4),
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k6-ts-'));
    const file = path.join(dir, 'metrics.json');
    fs.writeFileSync(file, raw);
    try {
      const { points } = downsampleK6JsonMetrics(file, { intervalSec: 5 });
      assert.equal(points.length, 1);
      assert.equal(points[0].vus, 2);
      assert.equal(points[0].http_reqs_rate, 4 / 5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats unknown custom metrics as trends when no Metric record is present', () => {
    const t0 = '2024-01-01T00:00:00.000Z';
    const { points, metrics } = downsampleK6JsonMetrics(
      ndjson([point('my_wait', t0, 12), point('my_wait', t0, 18)]),
      { intervalSec: 5 }
    );
    assert.equal(points[0]['my_wait.avg'], 15);
    assert.equal(points[0]['my_wait.p95'], 18);
    assert.equal(metrics[0].type, 'trend');
  });

  it('returns empty version-2 result for empty input', () => {
    const { points, intervalSec, version, metrics } = downsampleK6JsonMetrics('', { intervalSec: 5 });
    assert.equal(intervalSec, 5);
    assert.equal(version, 2);
    assert.deepEqual(points, []);
    assert.deepEqual(metrics, []);
  });
});


describe('buildTimeseriesAttachBody', () => {
  it('wraps points with version and intervalSec', () => {
    const body = buildTimeseriesAttachBody('run-1', [{ t_ms: 1, vus: 2 }], 5);
    assert.equal(body.runId, 'run-1');
    const parsed = JSON.parse(body.timeseriesJson);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.intervalSec, 5);
    assert.deepEqual(parsed.points, [{ t_ms: 1, vus: 2 }]);
  });

  it('accepts downsample result object and preserves version 2 catalog', () => {
    const body = buildTimeseriesAttachBody('run-2', {
      version: 2,
      intervalSec: 10,
      metrics: [{ name: 'http_reqs', type: 'counter', keys: ['http_reqs.count', 'http_reqs.rate'] }],
      points: [{ t_ms: 0, 'http_reqs.rate': 1 }],
    });
    const parsed = JSON.parse(body.timeseriesJson);
    assert.equal(parsed.version, 2);
    assert.equal(parsed.intervalSec, 10);
    assert.equal(parsed.points.length, 1);
    assert.equal(parsed.metrics[0].name, 'http_reqs');
  });

  it('uses version 2 catalog when wrapping a live downsample result', () => {
    const raw = ndjson([
      { type: 'Metric', metric: 'http_reqs', data: { type: 'counter' } },
      point('http_reqs', '2024-01-01T00:00:00.000Z', 2),
    ]);
    const result = downsampleK6JsonMetrics(raw, { intervalSec: 5 });
    const parsed = JSON.parse(buildTimeseriesAttachBody('run-3', result).timeseriesJson);
    assert.equal(parsed.version, 2);
    assert.equal(parsed.metrics[0].name, 'http_reqs');
    assert.deepEqual(parsed.metrics[0].keys, ['http_reqs.count', 'http_reqs.rate']);
    assert.equal(parsed.points[0]['http_reqs.count'], 2);
    assert.equal(parsed.points[0].http_reqs_rate, 2 / 5);
  });
});

describe('attachTimeseriesUrl', () => {
  it('uses resolveIngestBaseUrl from ingest', () => {
    assert.equal(
      attachTimeseriesUrl({ TESTCHIMP_INGRESS_URL: 'https://ingress-staging.testchimp.io/' }),
      'https://ingress-staging.testchimp.io/api/ingest_perf_run_timeseries'
    );
    assert.equal(
      ingestAttachUrl({}),
      'https://ingress.testchimp.io/api/ingest_perf_run_timeseries'
    );
  });
});
