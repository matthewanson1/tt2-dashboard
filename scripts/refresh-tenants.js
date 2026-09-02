#!/usr/bin/env node
// Syncs index.html's tenant list against LaunchDarkly's actual flag targeting.
// Runs in GitHub Actions (scheduled + manual dispatch) — no Snowflake/Salesforce
// access here, so newly-added tenants land with name: null (rendered as
// "Unknown (<id prefix>...)") until someone runs a Snowflake-backed refresh to
// fill in real names/industry/segment/usage.

const fs = require('fs');
const path = require('path');

const LD_TOKEN = process.env.LD_API_TOKEN;
const FLAG_KEY = 'time-tracking-redesign';
const INDEX_PATH = path.join(__dirname, '..', 'index.html');

if (!LD_TOKEN) {
  console.error('LD_API_TOKEN not set');
  process.exit(1);
}

async function ldFetch(url) {
  const res = await fetch(url, { headers: { Authorization: LD_TOKEN } });
  if (!res.ok) throw new Error(`LD API ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function getCurrentTargetIds() {
  const flag = await ldFetch(`https://app.launchdarkly.com/api/v2/flags/default/${FLAG_KEY}`);
  const trueIdx = flag.variations.findIndex(v => v.value === true);
  const targets = flag.environments.production.targets || [];
  const match = targets.find(t => t.variation === trueIdx);
  return new Set(match ? match.values : []);
}

async function findEnabledDate(tenantId) {
  let before;
  for (let page = 0; page < 20; page++) {
    let url = `https://app.launchdarkly.com/api/v2/auditlog?q=${FLAG_KEY}&limit=20`;
    if (before) url += `&before=${before}`;
    const d = await ldFetch(url);
    for (const item of d.items || []) {
      if (JSON.stringify(item).includes(tenantId)) {
        return new Date(item.date).toISOString().slice(0, 10);
      }
    }
    const next = d._links && d._links.next && d._links.next.href;
    const m = next && next.match(/before=(\d+)/);
    if (!m) break;
    before = m[1];
  }
  return null;
}

function loadArrays(html) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  // The page's script calls arbitrary DOM APIs at the bottom (getElementById,
  // querySelectorAll, SVG chart rendering, ...). Rather than stubbing each one by
  // hand and re-breaking every time the page gains a new render call — which is
  // exactly how this job broke with "document.querySelectorAll is not a function"
  // — hand it a Proxy that absorbs any property access, call, or construction.
  const stub = new Proxy(function () {}, {
    get: () => stub, set: () => true, apply: () => stub,
    construct: () => stub, has: () => true,
  });
  const fn = new Function(
    'document', 'window', 'console',
    script + '; return { CUSTOMER_ACCOUNTS, SNAPSHOT_TENANTS, SNAPSHOT_DATE };'
  );
  return fn(stub, stub, { log() {}, warn() {}, error() {} });
}

// This job owns ONLY the tenant ID list — which tenants are present. Every other
// field (goLiveDate, hours30d, employees30d, hoursOn20, employeesOn20, usage
// counts) is written by the Snowflake enrichment job and must survive untouched.
// Do NOT go back to a hardcoded field list: the previous version enumerated fields
// by hand, so it silently erased every column added after it was written and
// re-emitted `isLive`, a field removed on 2026-08-11. Serializing the whole object
// keeps this job forward-compatible with columns it has never heard of.
function serializeEntry(o) {
  return `  ${JSON.stringify(o)},`;
}

async function main() {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const { CUSTOMER_ACCOUNTS, SNAPSHOT_TENANTS } = loadArrays(html);
  const ldIds = await getCurrentTargetIds();

  const keptCustomers = CUSTOMER_ACCOUNTS.filter(c => ldIds.has(c.id));
  const keptTenants = SNAPSHOT_TENANTS.filter(t => ldIds.has(t.id));

  const knownIds = new Set([...keptCustomers.map(c => c.id), ...keptTenants.map(t => t.id)]);
  const newIds = [...ldIds].filter(id => !knownIds.has(id));

  const removedCount = (CUSTOMER_ACCOUNTS.length - keptCustomers.length) + (SNAPSHOT_TENANTS.length - keptTenants.length);

  for (const id of newIds) {
    const enabledDate = await findEnabledDate(id);
    keptTenants.push({
      id, name: null, enabledDate,
      webViews: 0, mobileEvents: 0,
      hours30d: 0, employees30d: 0, hoursOn20: 0, employeesOn20: 0,
    });
  }

  if (newIds.length === 0 && removedCount === 0) {
    console.log('No tenant list changes — still bumping snapshot date.');
  } else {
    console.log(`Added ${newIds.length} new tenant(s), removed ${removedCount}.`);
  }

  const today = new Date().toISOString().slice(0, 10);

  let out = html.replace(
    /const SNAPSHOT_DATE = '[^']*';/,
    `const SNAPSHOT_DATE = '${today}';`
  );
  out = out.replace(
    /const CUSTOMER_ACCOUNTS = \[[\s\S]*?\n\];/,
    `const CUSTOMER_ACCOUNTS = [\n${keptCustomers.map(serializeEntry).join('\n')}\n];`
  );
  out = out.replace(
    /const SNAPSHOT_TENANTS = \[[\s\S]*?\n\];/,
    `const SNAPSHOT_TENANTS = [\n${keptTenants.map(serializeEntry).join('\n')}\n];`
  );

  // Sanity check before writing: must still parse, and never contain forbidden fields.
  const forbidden = ['LD_TOKEN', 'accountExec', 'csm', 'coreLicenses', 'churnRisk', 'csat', 'arr'];
  for (const f of forbidden) {
    // Match each name only where it is actually a field/identifier — a JSON property
    // key ("csm":) or an assignment target (LD_TOKEN =) — never as a bare substring.
    // A plain out.includes(f) check false-positives on legitimate tenant data: the
    // short entries 'arr' and 'csat' hide inside real account names (e.g. the tenant
    // "SmartBarrel" contains "arr"), which would fail every refresh for no reason.
    const re = new RegExp(`"${f}"\\s*:|\\b${f}\\b\\s*[:=]`);
    if (re.test(out)) throw new Error(`Sanity check failed: forbidden field "${f}" present`);
  }
  // This job must NEVER touch LAST_ENRICHED_DATE. It syncs the tenant ID list only;
  // names, hours and usage come from the Snowflake job. If this job bumped that date,
  // the staleness banner would go straight back to being decorative — the page would
  // claim fresh data every morning while the numbers behind it aged for weeks, which
  // is exactly the failure the two-date split was introduced to end on 2026-09-02.
  const enrichedBefore = html.match(/const LAST_ENRICHED_DATE = '([^']*)';/);
  const enrichedAfter = out.match(/const LAST_ENRICHED_DATE = '([^']*)';/);
  if (enrichedBefore && (!enrichedAfter || enrichedAfter[1] !== enrichedBefore[1])) {
    throw new Error('Sanity check failed: LAST_ENRICHED_DATE was modified — only the Snowflake enrichment job may change it');
  }

  loadArrays(out); // throws if it doesn't parse

  fs.writeFileSync(INDEX_PATH, out);
  console.log('index.html updated.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
