#!/usr/bin/env node
'use strict';
/**
 * Snowflake enrichment for the TT 2.0 dashboard.
 *
 * scripts/refresh-tenants.js syncs WHICH tenants are on the flag — no credential
 * beyond LaunchDarkly, so it has always run unattended. This script fills in what
 * that one cannot: names, industry, segment, usage, hours, and the Analytics tab's
 * WEEKLY/MIGRATION datasets. Until 2026-09-02 that work only ever happened when a
 * human ran it against an interactive Okta session, which is why the numbers went
 * stale for 5, 10, 20 and 22 days on separate occasions while the page looked fine.
 *
 * Auth is key-pair JWT against the Snowflake SQL API — no SSO, no browser, no
 * interactive step — so this can run on GitHub's servers on a schedule.
 *
 * It bumps LAST_ENRICHED_DATE only on success. A failed run leaves the date alone
 * on purpose: that is what makes the page's staleness banner tell the truth.
 *
 * Offline test mode: `node enrich.js --offline fixtures.json` replays recorded
 * query results instead of calling Snowflake, so the whole pipeline (SQL build →
 * merge → rewrite → sanity check) is testable without a credential.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const WEB_EVENT = 'timesheets_and_timetracking_web_time_tracking_pageview_time_tracking_page';
const MOBILE_EVENTS = ['mobile_timesheet_touch_submit_day_level_', 'mobile_visit_details_touch_submit_timesheet_'];
const WEEKLY_START = '2025-12-29';

const q = s => `'${String(s).replace(/'/g, "''")}'`;
const list = xs => xs.map(q).join(',');
const today = () => new Date().toISOString().slice(0, 10);

// ── Reading the page ───────────────────────────────────────────────────────────
// Same catch-all Proxy stub as refresh-tenants.js: the page's script calls arbitrary
// DOM APIs, and stubbing them by hand breaks every time the page gains a render call.
function loadArrays(html) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const stub = new Proxy(function () {}, {
    get: () => stub, set: () => true, apply: () => stub, construct: () => stub, has: () => true,
  });
  const fn = new Function('document', 'window', 'console',
    script + '; return { CUSTOMER_ACCOUNTS, SNAPSHOT_TENANTS, NEXT_UP_TENANTS };');
  return fn(stub, stub, { log() {}, warn() {}, error() {} });
}

// ── Query construction ─────────────────────────────────────────────────────────
// Cutoffs are emitted from the same model the file is written from, so the query
// and the data can never drift apart.
function buildQueries(model) {
  const { customers, tenants } = model;
  const all = [...customers, ...tenants];
  const custIds = new Set(customers.map(c => c.id));
  const allIds = all.map(t => t.id);

  // Never let a tenant appear twice in a VALUES join — it fans out and double-counts.
  if (new Set(allIds).size !== allIds.length) throw new Error('duplicate tenant id in model');

  const cutoffs = all.map(t => `(${q(t.id)},${q(custIds.has(t.id) ? '2000-01-01' : (t.enabledDate || '2000-01-01'))})`).join(',');
  const dated = all.filter(t => (custIds.has(t.id) ? t.ttEnabledDate : t.enabledDate));
  const datedVals = dated.map(t => `(${q(t.id)},${q(custIds.has(t.id) ? t.ttEnabledDate : t.enabledDate)})`).join(',');
  const custList = list(customers.map(c => c.id));
  const datedCust = customers.filter(c => c.ttEnabledDate);

  return {
    // Names for tenants that have a Salesforce account (i.e. real customers).
    salesforce: `SELECT tenant_id, name, account_status, industry, segment, account_executive,
        customer_success_manager, active_core_licenses, buildops_core_go_live_date
      FROM PROD.INTERNAL_ANALYTICS.SALESFORCE_ACCOUNT WHERE tenant_id IN (${list(allIds)})`,

    // Training/demo tenants have no Salesforce row; their names live in product analytics.
    training: `SELECT tenant_id, tenant_name, MAX(created_time_utc) AS last_seen
      FROM PROD.INTERNAL_ANALYTICS.PRODUCT_ANALYTICS_SESSIONS_REDACTED
      WHERE tenant_id IN (${list(allIds)}) GROUP BY 1,2 ORDER BY 1, 3 DESC`,

    // Legacy Heap web/mobile counters, one pass instead of two.
    usage: `WITH cutoffs AS (SELECT column1 AS tenant_id, column2::date AS cutoff FROM VALUES ${cutoffs})
      SELECT c.tenant_id, COUNT_IF(e.event_table_name = ${q(WEB_EVENT)}) AS web_views,
        COUNT_IF(e.event_table_name IN (${list(MOBILE_EVENTS)})) AS mobile_events
      FROM cutoffs c
      JOIN PROD.INTERNAL_ANALYTICS.HEAP_SESSIONS_REDACTED s ON s.tenant_id = c.tenant_id
      JOIN PROD.INTERNAL_ANALYTICS.HEAP_ALL_EVENTS e ON e.session_id = s.session_id
      WHERE e.event_table_name IN (${list([WEB_EVENT, ...MOBILE_EVENTS])})
        AND e.created_time_utc >= c.cutoff GROUP BY c.tenant_id`,

    // The canonical adoption metric: real labour hours, last 30 days.
    hours30d: `SELECT se.TENANT_ID, COUNT(DISTINCT se.EMPLOYEE_ID) AS employees,
        ROUND(SUM(se.DURATION_MINS)/60.0,0) AS hours
      FROM PROD.APP_REDACTED.EMPLOYEE_TIMESHEET_SHIFT_ENTRY se
      WHERE se.IS_DELETED = FALSE AND se.TENANT_ID IN (${list(allIds)})
        AND se.WORK_DATE >= DATEADD(day,-30,CURRENT_DATE()) AND se.WORK_DATE < CURRENT_DATE()
      GROUP BY 1`,

    // Hours since each tenant's own enable date — the tightest honest "on 2.0" cut.
    hoursOn20: datedVals ? `WITH d AS (SELECT column1 AS tenant_id, column2::date AS enabled FROM VALUES ${datedVals})
      SELECT d.tenant_id, COUNT(DISTINCT se.EMPLOYEE_ID) AS employees,
        ROUND(SUM(se.DURATION_MINS)/60.0,0) AS hours
      FROM d JOIN PROD.APP_REDACTED.EMPLOYEE_TIMESHEET_SHIFT_ENTRY se ON se.TENANT_ID = d.tenant_id
      WHERE se.IS_DELETED = FALSE AND se.WORK_DATE >= d.enabled AND se.WORK_DATE < CURRENT_DATE()
      GROUP BY 1` : null,

    // Analytics tab. Hours capped at 24h/employee-day AT SOURCE — this removes TJW's
    // corrupt Feb–Jun spikes. ISO Monday buckets: DATE_TRUNC('week') depends on the
    // WEEK_START session parameter, DAYOFWEEKISO does not.
    weekly: `WITH ed AS (
        SELECT se.TENANT_ID AS tid, se.EMPLOYEE_ID AS eid, se.WORK_DATE AS wd,
          LEAST(SUM(se.DURATION_MINS)/60.0, 24) AS hrs
        FROM PROD.APP_REDACTED.EMPLOYEE_TIMESHEET_SHIFT_ENTRY se
        WHERE se.IS_DELETED = FALSE AND se.TENANT_ID IN (${custList})
          AND se.WORK_DATE >= ${q(WEEKLY_START)} AND se.WORK_DATE < CURRENT_DATE()
        GROUP BY 1,2,3)
      SELECT LEFT(tid,8) AS id, TO_CHAR(DATEADD(day, -(DAYOFWEEKISO(wd)-1), wd),'YYYY-MM-DD') AS wk,
        ROUND(SUM(hrs),0) AS capped_hours, COUNT(DISTINCT eid) AS employees, COUNT(*) AS employee_days
      FROM ed GROUP BY 1,2 HAVING SUM(hrs) >= 0.5 ORDER BY 1,2`,

    // Migration signature. Capped hours, exact dates (not weeks): before = 60-day
    // daily average pre-cutover, after = daily average since.
    migration: datedCust.length ? `WITH d AS (SELECT column1 AS tid, column2::date AS enabled FROM VALUES
        ${datedCust.map(c => `(${q(c.id)},${q(c.ttEnabledDate)})`).join(',')}),
      ed AS (SELECT se.TENANT_ID AS tid, se.EMPLOYEE_ID AS eid, se.WORK_DATE AS wd,
        LEAST(SUM(se.DURATION_MINS)/60.0,24) AS cap_hrs
        FROM PROD.APP_REDACTED.EMPLOYEE_TIMESHEET_SHIFT_ENTRY se
        WHERE se.IS_DELETED = FALSE GROUP BY 1,2,3)
      SELECT d.tid, d.enabled,
        ROUND(SUM(CASE WHEN ed.wd >= DATEADD(day,-60,d.enabled) AND ed.wd < d.enabled THEN ed.cap_hrs END)/60.0,1) AS before_cap,
        ROUND(SUM(CASE WHEN ed.wd >= d.enabled THEN ed.cap_hrs END)/NULLIF(DATEDIFF(day,d.enabled,CURRENT_DATE()),0),1) AS after_cap,
        DATEDIFF(day,d.enabled,CURRENT_DATE()) AS days_since
      FROM d JOIN ed ON ed.tid = d.tid GROUP BY 1,2 ORDER BY 1` : null,
  };
}

// ── Snowflake SQL API over key-pair JWT ────────────────────────────────────────
function makeJwt(account, user, privateKeyPem) {
  // Snowflake wants the account identifier without region/cloud suffix, uppercased.
  const acct = account.toUpperCase().split('.')[0];
  const qualified = `${acct}.${user.toUpperCase()}`;
  const key = crypto.createPrivateKey(privateKeyPem);
  const pubDer = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  const fp = 'SHA256:' + crypto.createHash('sha256').update(pubDer).digest('base64');
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const body = b64({ iss: `${qualified}.${fp}`, sub: qualified, iat: now, exp: now + 3540 });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function makeExecutor(cfg) {
  const host = `https://${cfg.account.toLowerCase()}.snowflakecomputing.com`;
  const jwt = makeJwt(cfg.account, cfg.user, cfg.privateKey);
  const headers = {
    'Authorization': `Bearer ${jwt}`,
    'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  // Rows come back as arrays of strings; NULL is null. Everything downstream expects
  // that shape, which is also exactly what the offline fixtures record.
  const collect = async (body, handle) => {
    let rows = body.data || [];
    const total = body.resultSetMetaData?.numRows ?? rows.length;
    let part = 1;
    const partitions = body.resultSetMetaData?.partitionInfo?.length ?? 1;
    while (part < partitions) {
      const r = await fetch(`${host}/api/v2/statements/${handle}?partition=${part}`, { headers });
      if (!r.ok) throw new Error(`partition ${part} fetch failed: ${r.status} ${await r.text()}`);
      rows = rows.concat(await r.json());
      part++;
    }
    if (rows.length !== total) throw new Error(`row count mismatch: got ${rows.length}, expected ${total}`);
    return rows;
  };

  return async function exec(statement) {
    const res = await fetch(`${host}/api/v2/statements`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        statement, timeout: 300,
        warehouse: cfg.warehouse, role: cfg.role,
        database: 'PROD', schema: 'INTERNAL_ANALYTICS',
      }),
    });
    if (res.status === 202) {
      const { statementHandle } = await res.json();
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const p = await fetch(`${host}/api/v2/statements/${statementHandle}`, { headers });
        if (p.status === 202) continue;
        if (!p.ok) throw new Error(`poll failed: ${p.status} ${await p.text()}`);
        const body = await p.json();
        return collect(body, statementHandle);
      }
      throw new Error('statement did not finish within 2 minutes');
    }
    if (!res.ok) throw new Error(`statement failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    return collect(body, body.statementHandle);
  };
}


// ── Merging results into the model ─────────────────────────────────────────────
const num = v => (v === null || v === '' ? 0 : Number(v));
const pair = rows => Object.fromEntries(rows.map(r => [r[0], [num(r[1]), num(r[2])]]));

function applyResults(model, r) {
  const { customers, tenants } = model;
  const custIds = new Set(customers.map(c => c.id));
  const usage = pair(r.usage);
  const h30 = pair(r.hours30d);
  const hOn = pair(r.hoursOn20 || []);

  // Salesforce rows identify real customers; anything without one is training/test.
  const sf = {};
  for (const row of r.salesforce) {
    const [tenant_id, name, account_status, industry, segment, , , , goLive] = row;
    sf[tenant_id] = { name, account_status, industry, segment, goLive };
  }
  // Training names: first row per tenant wins (query orders newest last_seen first).
  const tn = {};
  for (const [id, name] of r.training) if (!(id in tn)) tn[id] = name;

  for (const t of [...customers, ...tenants]) {
    const s = sf[t.id];
    if (s && s.name) {
      t.name = s.name;
      // Salesforce often returns industry blank for tenants that already carry a
      // human-derived value here. Never blank out something real with an empty.
      if (s.industry) t.industry = s.industry;
      if (s.segment) t.segment = s.segment;
      // index.html is the PUBLIC file. Salesforce also returns account_executive,
      // customer_success_manager and active_core_licenses — deliberately NOT written
      // here. An earlier draft set them and the sanity check below caught it before
      // it ever published, which is precisely what that check is for. Only these
      // three Salesforce fields are public-safe.
      if (custIds.has(t.id) && s.goLive) t.goLiveDate = s.goLive;
    } else if (!t.name && tn[t.id]) {
      t.name = tn[t.id];
    }
    t.webViews = usage[t.id] ? usage[t.id][0] : 0;
    t.mobileEvents = usage[t.id] ? usage[t.id][1] : 0;
    t.employees30d = h30[t.id] ? h30[t.id][0] : 0;
    t.hours30d = h30[t.id] ? h30[t.id][1] : 0;
    const dated = custIds.has(t.id) ? t.ttEnabledDate : t.enabledDate;
    t.employeesOn20 = dated ? (hOn[t.id] ? hOn[t.id][0] : 0) : null;
    t.hoursOn20 = dated ? (hOn[t.id] ? hOn[t.id][1] : 0) : null;
  }

  const weekly = r.weekly.map(([id, wk, hrs, emps, days]) => [id, wk, num(hrs), num(emps), num(days)]);
  const weeks = [...new Set(weekly.map(w => w[1]))].sort();

  const byId = Object.fromEntries(customers.map(c => [c.id.slice(0, 8), c]));
  const migration = (r.migration || [])
    .map(([tid, , before, after, days]) => {
      const c = customers.find(x => x.id === tid);
      return c && num(after) > 0
        ? { name: shortName(c.name), before: num(before), after: num(after), days: num(days) }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.after - a.after);

  return { weekly, partialWeek: weeks[weeks.length - 1] || null, migration };
}

// The migration chart is narrow; full Salesforce names overflow it. Keep the same
// short labels the hand-built version used so the chart stays readable across runs.
const SHORT = {
  'Calray Gas Heat Corp. dba Omnia Mechanical Group': 'Calray / Omnia',
  'New England Mechanical Overlay, Inc.': 'New England Mechanical',
  'Fleming Network & Security Services': 'Fleming Network & Security',
  'Cabworks Custom Elevators': 'Cabworks',
  'Creative Cabling Solutions': 'Creative Cabling',
  'TJW Industrial, Inc.': 'TJW Industrial',
};
const shortName = n => SHORT[n] || String(n || '').replace(/,? (Inc|LLC|Ltd|Corp)\.?$/i, '');

// ── Writing the page ───────────────────────────────────────────────────────────
// Swap only the data constants. Never regenerate markup or render code from here —
// that is hand-maintained and correct, and rewriting it is how you lose features.
function writeHtml(html, model, extra) {
  const ser = a => '[\n' + a.map(x => '  ' + JSON.stringify(x)).join(',\n') + '\n]';
  const sub = (s, name, text) => {
    const re = new RegExp(`(const ${name} = )(\\[[\\s\\S]*?\\n\\]|\\[.*?\\]|'[^']*');`);
    if (!re.test(s)) throw new Error(`could not find const ${name}`);
    return s.replace(re, (_, p) => p + text + ';');
  };
  let out = html;
  out = sub(out, 'CUSTOMER_ACCOUNTS', ser(model.customers));
  out = sub(out, 'SNAPSHOT_TENANTS', ser(model.tenants));
  out = sub(out, 'NEXT_UP_TENANTS', ser(model.nextUp));
  out = sub(out, 'WEEKLY', JSON.stringify(extra.weekly));
  out = sub(out, 'MIGRATION', JSON.stringify(extra.migration));
  if (extra.partialWeek) out = sub(out, 'PARTIAL_WEEK', `'${extra.partialWeek}'`);
  out = sub(out, 'LAST_ENRICHED_DATE', `'${today()}'`);
  return out;
}

// Same privacy guard as refresh-tenants.js: match real field positions, never bare
// substrings — "SmartBarrel" contains "arr" and broke that job for exactly this reason.
function sanityCheck(out) {
  for (const f of ['LD_TOKEN', 'accountExec', 'csm', 'coreLicenses', 'churnRisk', 'csat', 'arr']) {
    if (new RegExp(`"${f}"\\s*:|\\b${f}\\b\\s*[:=]`).test(out)) {
      throw new Error(`Sanity check failed: forbidden field "${f}" present`);
    }
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(out)) throw new Error('Sanity check failed: private key leaked into output');
  const a = loadArrays(out);
  if (!a.CUSTOMER_ACCOUNTS.length || !a.SNAPSHOT_TENANTS.length) throw new Error('Sanity check failed: empty arrays');
  return a;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const offlineIdx = process.argv.indexOf('--offline');
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const arrays = loadArrays(html);
  const model = {
    customers: arrays.CUSTOMER_ACCOUNTS,
    tenants: arrays.SNAPSHOT_TENANTS,
    nextUp: arrays.NEXT_UP_TENANTS,
  };
  const queries = buildQueries(model);

  let results;
  if (offlineIdx !== -1) {
    // Replay recorded results: proves everything except the HTTP/auth hop.
    results = JSON.parse(fs.readFileSync(process.argv[offlineIdx + 1], 'utf8'));
    console.log('offline mode — replaying recorded query results');
  } else {
    const cfg = {
      account: process.env.SNOWFLAKE_ACCOUNT,
      user: process.env.SNOWFLAKE_USER,
      privateKey: process.env.SNOWFLAKE_PRIVATE_KEY,
      role: process.env.SNOWFLAKE_ROLE || 'PRODUCT_DESIGN_ROLE',
      warehouse: process.env.SNOWFLAKE_WAREHOUSE || 'MCP_WH',
    };
    for (const k of ['account', 'user', 'privateKey']) {
      if (!cfg[k]) throw new Error(`SNOWFLAKE_${k === 'privateKey' ? 'PRIVATE_KEY' : k.toUpperCase()} not set`);
    }
    const exec = makeExecutor(cfg);
    results = {};
    for (const [name, sql] of Object.entries(queries)) {
      if (!sql) { results[name] = []; continue; }
      process.stdout.write(`  ${name} … `);
      results[name] = await exec(sql);
      console.log(`${results[name].length} rows`);
    }
  }

  const extra = applyResults(model, results);
  const named = [...model.customers, ...model.tenants, ...model.nextUp];
  const unnamed = named.filter(t => !t.name).length;
  console.log(`customers ${model.customers.length} · training ${model.tenants.length} · next-up ${model.nextUp.length} · unnamed ${unnamed}`);
  console.log(`weekly ${extra.weekly.length} rows through ${extra.partialWeek} · migration ${extra.migration.length} tenants`);

  const out = writeHtml(html, model, extra);
  sanityCheck(out);
  fs.writeFileSync(INDEX_PATH, out);
  console.log(`index.html enriched; LAST_ENRICHED_DATE set to ${today()}.`);
}

if (require.main === module) {
  main().catch(err => {
    // Deliberately do NOT touch LAST_ENRICHED_DATE on failure — leaving it behind is
    // what lets the page's own staleness banner report the outage.
    console.error(err);
    process.exit(1);
  });
}
