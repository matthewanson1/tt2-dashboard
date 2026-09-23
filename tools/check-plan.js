#!/usr/bin/env node
// Diff the dashboard's imported PLAN against the Confluence migration plan.
//
// Confluence is the source of truth. The plan block in index.html is a hand
// import (the enrichment job cannot regenerate it), so it drifts silently the
// moment the tranche table is re-cut. Run this after any plan revision, and
// before publishing, to prove the two still agree.
//
//   CONFLUENCE_USERNAME=... CONFLUENCE_API_TOKEN=... node tools/check-plan.js
//
// Credentials are read from the environment only — nothing is stored in the repo,
// which is also why this cannot run in the nightly Action.
const fs = require('fs');
const PAGE = '4851826814';
const user = process.env.CONFLUENCE_USERNAME, tok = process.env.CONFLUENCE_API_TOKEN;
if (!user || !tok) { console.error('set CONFLUENCE_USERNAME and CONFLUENCE_API_TOKEN'); process.exit(2); }

const strip = x => x.replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g,'&').replace(/&ndash;/g,'-').replace(/&mdash;/g,'—').replace(/&nbsp;/g,' ')
  .replace(/\s+/g,' ').trim();
const MON = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
const iso = d => { const m = d.match(/^(\w{3}) (\d{1,2}), (\d{4})$/); return m ? `${m[3]}-${MON[m[1]]}-${String(m[2]).padStart(2,'0')}` : null; };

(async () => {
  const auth = Buffer.from(`${user}:${tok}`).toString('base64');
  const r = await fetch(`https://buildops.atlassian.net/wiki/rest/api/content/${PAGE}?expand=body.storage`,
                        { headers: { Authorization: 'Basic ' + auth } });
  if (!r.ok) { console.error('Confluence fetch failed:', r.status); process.exit(2); }
  const body = (await r.json()).body.storage.value;

  const h = body.indexOf('<th><p>Tranche</p></th>');
  if (h < 0) { console.error('tranche table not found — has the doc structure changed?'); process.exit(2); }
  const ts = body.lastIndexOf('<table', h), te = body.indexOf('</table>', ts);
  const want = [];
  for (const row of body.slice(ts, te).match(/<tr>[\s\S]*?<\/tr>/g) || []) {
    const c = row.match(/<td>[\s\S]*?<\/td>/g) || [];
    if (c.length !== 7) continue;
    const [tr, wk, mg, grp, n, cum] = c.slice(0, 6).map(strip);
    if (tr === '0' || tr === '—' || n === '0') continue;
    want.push({ week: iso(wk), migrate: iso(mg), group: grp, n: +n, cum: +cum });
  }

  const s = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  const slice = (k) => { const i = s.indexOf(k); return s.slice(i, s.indexOf('];', i) + 2).replace(k, ''); };
  const got = eval(slice('const PLAN ='));
  const total = +s.match(/const PLAN_TOTAL = (\d+)/)[1];

  const diffs = [];
  if (got.length !== want.length) diffs.push(`week count: page ${got.length} vs doc ${want.length}`);
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    const a = got[i], b = want[i];
    if (!a || !b) { diffs.push(`week ${i + 1}: ${a ? 'only on page' : 'only in doc'}`); continue; }
    for (const k of ['week', 'migrate', 'group', 'n', 'cum'])
      if (String(a[k]) !== String(b[k])) diffs.push(`week ${i + 1} (${b.week}) ${k}: page ${a[k]} vs doc ${b[k]}`);
  }
  const lastCum = want.length ? want[want.length - 1].cum : 0;
  if (total !== lastCum) diffs.push(`PLAN_TOTAL ${total} vs doc final cumulative ${lastCum}`);

  if (diffs.length) { console.error('PLAN DRIFT — dashboard does not match Confluence:'); diffs.forEach(d => console.error('  ' + d)); process.exit(1); }
  console.log(`plan matches Confluence — ${want.length} weeks, ${lastCum} tenants, first cutover ${want[0].migrate}`);
})();
