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
  const stub = `
    const document = { getElementById: () => ({ textContent: '', classList: { remove(){} } }) };
  `;
  const body = script.replace(/document\.getElementById\('refreshed-at'\)[\s\S]*?checkStaleness\(\);/, '');
  const fn = new Function(stub + body + '; return { CUSTOMER_ACCOUNTS, SNAPSHOT_TENANTS, SNAPSHOT_DATE };');
  return fn();
}

function serializeCustomer(c) {
  return `  { id: '${c.id}', name: ${JSON.stringify(c.name)},\n` +
    `    industry: ${JSON.stringify(c.industry)}, segment: ${JSON.stringify(c.segment)}, isLive: ${c.isLive},\n` +
    `    ttEnabledDate: ${JSON.stringify(c.ttEnabledDate)}, webViews: ${c.webViews || 0}, mobileEvents: ${c.mobileEvents || 0} },`;
}

function serializeTenant(t) {
  return `  { id: '${t.id}', name: ${JSON.stringify(t.name)}, enabledDate: ${JSON.stringify(t.enabledDate)}, webViews: ${t.webViews || 0}, mobileEvents: ${t.mobileEvents || 0} },`;
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
    keptTenants.push({ id, name: null, enabledDate, webViews: 0, mobileEvents: 0 });
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
    `const CUSTOMER_ACCOUNTS = [\n${keptCustomers.map(serializeCustomer).join('\n')}\n];`
  );
  out = out.replace(
    /const SNAPSHOT_TENANTS = \[[\s\S]*?\n\];/,
    `const SNAPSHOT_TENANTS = [\n${keptTenants.map(serializeTenant).join('\n')}\n];`
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
  loadArrays(out); // throws if it doesn't parse

  fs.writeFileSync(INDEX_PATH, out);
  console.log('index.html updated.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
