#!/usr/bin/env node
'use strict';
// Post-refresh regression check. Run before publishing, every time.
//
//   node tools/check.js
//
// Covers the three things that have actually broken in the past: a chart silently
// rendering nothing, the tab routing failing so deep links land on the wrong panel,
// and a tenant id or forbidden field slipping into the published file.
const fs = require('fs');
const { INDEX, enrichLib } = require('./lib');

const html = fs.readFileSync(INDEX, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const PANELS = ['panel-tenants', 'panel-analytics', 'panel-plan', 'panel-runway'];

// A catch-all Proxy cannot be used for getElementById: numeric comparisons against a
// Proxy never terminate and renderRunway hangs forever. Concrete stub, always.
const mkNode = id => ({
  id, kids: [], text: null, _html: '', style: {}, dataset: {}, hidden: true,
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  appendChild(c) { this.kids.push(c); return c; },
  setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
  addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
  set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
  set textContent(v) { this.text = v; }, get textContent() { return this.text; },
});

function run(startHash) {
  const nodes = new Map();
  const buttons = PANELS.map(id => {
    const b = {
      dataset: { panel: id }, _cls: new Set(['tab-btn']), _click: null,
      classList: {
        add: c => b._cls.add(c), remove: c => b._cls.delete(c),
        toggle: (c, on) => (on ? b._cls.add(c) : b._cls.delete(c)),
        contains: c => b._cls.has(c),
      },
      addEventListener: (ev, fn) => { if (ev === 'click') b._click = fn; },
      get active() { return b._cls.has('active'); },
    };
    return b;
  });
  for (const id of PANELS) nodes.set(id, mkNode(id));

  const generic = new Proxy(function () {}, {
    get: () => generic, set: () => true, apply: () => generic,
    construct: () => generic, has: () => true,
  });
  const doc = new Proxy({}, {
    has: () => true,
    get: (_t, p) => {
      if (p === 'querySelectorAll') return sel => (sel === '.tab-btn' ? buttons : []);
      if (p === 'getElementById') return id => {
        if (!nodes.has(id)) nodes.set(id, mkNode(id));
        return nodes.get(id);
      };
      if (p === 'createElementNS' || p === 'createElement') return () => mkNode('el');
      return generic;
    },
  });
  const listeners = {};
  const win = new Proxy({}, {
    has: () => true,
    get: (_t, p) => (p === 'addEventListener' ? (ev, fn) => { listeners[ev] = fn; } : generic),
  });
  const loc = { pathname: '/', search: '', hash: startHash };
  const location = new Proxy(loc, {
    get: (t, p) => t[p],
    set: (t, p, v) => {
      if (p === 'hash') {
        const next = String(v).startsWith('#') ? String(v) : '#' + v;
        if (t.hash !== next) { t.hash = next; if (listeners.hashchange) listeners.hashchange(); }
        return true;
      }
      t[p] = v; return true;
    },
  });
  const history = { replaceState: (_s, _t, url) => { loc.hash = '#' + String(url).split('#')[1]; } };

  const api = new Function('document', 'window', 'console', 'location', 'history',
    script + '; return { renderAnalytics, renderPlan, renderRunway };')
    (doc, win, { log() {}, warn() {}, error() {} }, location, history);
  return { nodes, loc, api, visible: () => PANELS.filter(id => !nodes.get(id).hidden) };
}

let fails = 0;
const ok = (cond, label, detail) => {
  if (!cond) fails++;
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `  — ${detail}`}`);
};

// 1. Every chart draws.
const r = run('');
r.api.renderAnalytics(); r.api.renderPlan(); r.api.renderRunway();
const CHARTS = ['chart-impossible', 'chart-trend', 'chart-review', 'chart-payroll', 'chart-flows',
  'chart-reports', 'chart-stack', 'chart-hpd', 'chart-emps', 'chart-mig', 'chart-cum'];
for (const id of CHARTS) {
  const n = r.nodes.has(id) ? r.nodes.get(id).kids.length : 0;
  ok(n > 0, `${id} draws`, `${n} svg children`);
}
const scRows = (r.nodes.get('score-table').innerHTML.match(/<tr>/g) || []).length;
ok(scRows === 5, 'scorecard table has header + 4 rows', `${scRows} rows`);

// 2. Tab routing: deep link lands right and renders, bad hash self-corrects.
const deep = run('#analytics');
ok(deep.visible().join() === 'panel-analytics', 'deep link #analytics opens Analytics', deep.visible().join());
ok(deep.nodes.get('chart-review').kids.length > 0, 'deep link renders the tab it lands on');
const bad = run('#nonsense');
ok(bad.visible().join() === 'panel-tenants', 'unknown hash falls back to Tenants');
ok(bad.loc.hash === '#tenants', 'unknown hash is rewritten', bad.loc.hash);

// 3. Nothing private, and tenant ids intact.
const lib = enrichLib();
try { lib.sanityCheck(html); ok(true, 'privacy guard (no accountExec/csm/coreLicenses/tokens)'); }
catch (e) { ok(false, 'privacy guard', e.message); }
const a = lib.loadArrays(html);
const allT = [...a.CUSTOMER_ACCOUNTS, ...a.SNAPSHOT_TENANTS, ...a.NEXT_UP_TENANTS];
ok(allT.every(t => t.id && t.id.length === 36), 'every tenant id is a full 36-char UUID');
const onTt2 = new Set([...a.CUSTOMER_ACCOUNTS, ...a.SNAPSHOT_TENANTS].map(t => t.id));
const overlap = a.NEXT_UP_TENANTS.filter(t => onTt2.has(t.id));
ok(overlap.length === 0, 'no Next Up tenant is already on 2.0', overlap.map(t => t.name).join());
const unnamed = allT.filter(t => !t.name).length;
console.log(`      (${a.CUSTOMER_ACCOUNTS.length} customers · ${a.SNAPSHOT_TENANTS.length} training · ${a.NEXT_UP_TENANTS.length} next-up · ${unnamed} unnamed)`);

console.log(fails ? `\n${fails} check(s) FAILED — do not publish` : '\nall checks passed');
process.exit(fails ? 1 : 0);
