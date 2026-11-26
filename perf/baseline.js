// k6 load test (MVP-117, D-235): list cases, get case, search, dashboard and upload ack, 50 VUs each, one after the other,
// against a backend on the perf seed (apps/backend-api/prisma/seed-perf.ts). How to run: docs/perf/baseline.md.
// Every request carries its own X-Forwarded-For (the API trusts one proxy hop): the per-IP rate limits stay on, but
// 50 users of one machine would otherwise share one IP's budget.
import { check, sleep } from 'k6';
import http from 'k6/http';

const BASE = __ENV.BASE_URL || 'http://host.docker.internal:3000/api/v1';
const PASSWORD = __ENV.PERF_PASSWORD;
const OFFICES = Number(__ENV.PERF_OFFICES || 20);
const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || '60s';
// Scenarios start one after the other: the duration (seconds) plus 10 s for the last requests to finish.
const STEP = Number(__ENV.STEP_SECONDS || parseInt(DURATION, 10) + 10);
// Half the searches use a word of the seed's small vocabulary, found in most rows (the worst case: about 3 in 4 documents),
// half a word of its 2,000 others or a file number, as a name or a number is usually typed.
const COMMON = ['عقد', 'ايجار', 'المدرسه', 'lease', 'contract', 'تعويض', 'احمد النور', 'claim'];
const rare = () =>
  Math.random() < 0.5
    ? `كلمة${Math.floor(Math.random() * 2000)}`
    : `P-0${1000 + Math.floor(Math.random() * 4000)}`;

// ONLY=search,dashboard runs some scenarios (the thresholds of the others then have no data and pass).
const ONLY = (__ENV.ONLY || 'list,get,search,dashboard,upload').split(',');

const scenario = (exec, index) => ({
  executor: 'constant-vus',
  exec,
  vus: VUS,
  duration: DURATION,
  startTime: `${index * STEP}s`,
  tags: { endpoint: exec },
});

export const options = {
  setupTimeout: '120s',
  scenarios: Object.fromEntries(ONLY.map((name, index) => [name, scenario(name, index)])),
  thresholds: {
    'http_req_duration{endpoint:list}': ['p(95)<500'],
    'http_req_duration{endpoint:get}': ['p(95)<500'],
    'http_req_duration{endpoint:search}': ['p(95)<200'],
    // Each half of the search mix within the budget too (MVP-172); the two steps reported apart, never failing.
    'http_req_duration{endpoint:search,term:common}': ['p(95)<200'],
    'http_req_duration{endpoint:search,term:rare}': ['p(95)<200'],
    'http_req_duration{endpoint:search,step:names}': ['p(95)<100000'],
    'http_req_duration{endpoint:search,step:documents}': ['p(95)<100000'],
    'http_req_duration{endpoint:dashboard}': ['p(95)<500'],
    'http_req_duration{endpoint:upload}': ['p(95)<2000'],
    http_req_failed: ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const ip = () => `10.${117 + (__VU >> 8)}.${__VU & 255}.${1 + (__ITER % 250)}`;
const email = (office, key) =>
  `perf-o${String(office).padStart(2, '0')}-${key}@perf.nexlegtiq.test`;

export function setup() {
  if (!PASSWORD) throw new Error('Set PERF_PASSWORD (the one seed-perf used)');
  const sessions = [];
  for (let office = 1; office <= OFFICES; office += 1) {
    for (const [n, key] of ['manager', 'lawyer1'].entries()) {
      const res = http.post(
        `${BASE}/auth/login`,
        JSON.stringify({ email: email(office, key), password: PASSWORD }),
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': `10.250.${office}.${n + 1}`,
          },
          tags: { endpoint: 'setup' },
        },
      );
      if (res.status !== 200)
        throw new Error(`login ${email(office, key)}: ${res.status} ${res.body}`);
      const token = res.json('data.accessToken');
      // The lawyer's files: every account of the office may open them.
      const files =
        key === 'lawyer1'
          ? http
              .get(`${BASE}/cases?limit=100`, {
                headers: { Authorization: `Bearer ${token}` },
                tags: { endpoint: 'setup' },
              })
              .json('data')
              .map((file) => file.id)
          : [];
      sessions.push({ office, key, token, files });
    }
  }
  // Every account of an office shares the lawyer's file ids.
  for (const session of sessions)
    session.files = sessions.find((s) => s.office === session.office && s.files.length).files;
  return { sessions };
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
// Managers and lawyers alternate: the lawyer's queries carry the assigned-scope filters.
const session = (data) => data.sessions[__VU % data.sessions.length];
const headers = (s, extra = {}) => ({
  Authorization: `Bearer ${s.token}`,
  'X-Forwarded-For': ip(),
  ...extra,
});
const ok = (res, status = 200) => check(res, { [`status ${status}`]: (r) => r.status === status });

export function list(data) {
  const s = session(data);
  const page = 1 + Math.floor(Math.random() * 3);
  const status = Math.random() < 0.5 ? '&status=OPEN' : '';
  ok(
    http.get(`${BASE}/cases?page=${page}&limit=20${status}`, {
      headers: headers(s),
      tags: { endpoint: 'list' },
    }),
  );
  sleep(1);
}

export function get(data) {
  const s = session(data);
  ok(
    http.get(`${BASE}/cases/${pick(s.files)}`, { headers: headers(s), tags: { endpoint: 'get' } }),
  );
  sleep(1);
}

export function search(data) {
  const s = session(data);
  const term = Math.random() < 0.5 ? 'common' : 'rare';
  const q = encodeURIComponent(term === 'common' ? pick(COMMON) : rare());
  // The overlay's two steps (D-240): names at once, document text after the typing pause (DOCUMENTS_PAUSE_MS).
  const get = (type) =>
    ok(
      http.get(`${BASE}/search?q=${q}&type=${type}`, {
        headers: headers(s),
        tags: { endpoint: 'search', term, step: type },
      }),
    );
  get('names');
  sleep(0.6);
  get('documents');
  sleep(1);
}

export function dashboard(data) {
  const s = session(data);
  ok(http.get(`${BASE}/dashboard`, { headers: headers(s), tags: { endpoint: 'dashboard' } }));
  sleep(1);
}

// A one-page PDF of ~10 KB; the form names the file before the file part, as the API requires.
const PDF = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n% ${'x'.repeat(10_000)}\ntrailer<</Root 1 0 R>>\n%%EOF\n`;
const BOUNDARY = 'nexlegtiq-perf-boundary';

export function upload(data) {
  const s = session(data);
  const body =
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="fileId"\r\n\r\n${pick(s.files)}\r\n` +
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="perf-${__VU}-${__ITER}.pdf"\r\n` +
    `Content-Type: application/pdf\r\n\r\n${PDF}\r\n--${BOUNDARY}--\r\n`;
  const res = http.post(`${BASE}/documents`, body, {
    headers: headers(s, { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` }),
    tags: { endpoint: 'upload' },
  });
  ok(res, 202);
  sleep(1);
}
