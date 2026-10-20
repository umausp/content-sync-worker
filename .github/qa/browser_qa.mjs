#!/usr/bin/env node
// Browser QA against the built site served by the local rig. Playwright and axe are resolved from --deps (installed
// by section_browser.sh outside the repo), so this file has no package.json of its own.
// Usage: node .github/qa/browser_qa.mjs --base http://localhost:8787 --deps <dir> --out <qa-out dir>
// Writes <out>/browser_results.json and <out>/screenshots/*.png. Exit 1 on any fail. Warnings never fail.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = parseArgs(process.argv.slice(2));
if (!args.deps) {
  console.error('usage: node browser_qa.mjs --base <url> --deps <dir> --out <dir>');
  process.exit(2);
}
const req = createRequire(join(args.deps, 'package.json'));
const { chromium } = req('playwright');
const axeMod = req('@axe-core/playwright');
const AxeBuilder = axeMod.AxeBuilder || axeMod.default;

const VIEWPORTS = [{ w: 375, h: 812 }, { w: 1280, h: 800 }];
const PAGES = ['/news', '/watch/chipsupply', '/news/edition/jp', '/news/edition/ar', '/news/edition/in', '/advertise', '/editorial-policy', '/corrections'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const RTL_PATH = /\/edition\/ar(\/|$)/;

function parseArgs(argv) {
  const get = (k, d) => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
  };
  return {
    base: get('--base', 'http://localhost:8787').replace(/\/+$/, ''),
    deps: get('--deps', null),
    out: get('--out', 'qa-out'),
  };
}

const add = (res, id, status, detail = '') => res.checks.push({ id, status, detail: String(detail).slice(0, 400) });

/** Console errors that are not ours: failed loads from third-party hosts and from the rig's API stub. */
function isBadConsole(c) {
  if (!/^Failed to load resource/i.test(c.text)) return true;
  let u;
  try {
    u = new URL(c.url);
  } catch {
    return true;
  }
  if (!LOCAL_HOSTS.has(u.hostname)) return false;
  if (/^\/(api\/|news\/stories)/.test(u.pathname)) return false;
  return true;
}

// Runs in the page: small tap targets (height < 44px) that are visible in the first viewport.
function smallTargets() {
  const out = [];
  for (const el of document.querySelectorAll('a[href], button, [role="button"], input[type="submit"]')) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || r.width === 0 || r.height === 0) continue;
    if (r.bottom < 0 || r.top > window.innerHeight) continue;
    if (r.height < 44) {
      const label = (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 40);
      out.push(`${label} (${Math.round(r.height)}px)`);
    }
  }
  return out;
}

// Runs in the page: honeypot candidates, unlabelled fields, and text claims on /advertise.
function advertiseForm() {
  const isHidden = (e) => {
    const cs = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    return cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0
      || (r.width === 0 && r.height === 0) || !!e.closest('[aria-hidden="true"]');
  };
  const fields = [...document.querySelectorAll('form input, form select, form textarea')]
    .filter((e) => !['hidden', 'submit', 'button', 'image', 'reset'].includes(e.type));
  const honeyRe = /honey|(^|[-_])hp([-_]|$)|trap|bot/i;
  const honeyEls = fields.filter((e) => honeyRe.test(`${e.name || ''} ${e.id || ''}`));
  const labelled = (e) => (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`))
    || e.closest('label') || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby');
  const unlabelled = fields
    .filter((e) => !honeyEls.includes(e) && !labelled(e))
    .map((e) => e.name || e.id || e.type || e.tagName);
  const text = document.body ? document.body.innerText || '' : '';
  const claims = [...text.matchAll(/[^\n]{0,30}(%|million)[^\n]{0,30}/gi)].map((m) => m[0].trim()).slice(0, 3);
  return {
    forms: document.forms.length,
    fields: fields.length,
    honey: honeyEls.map((e) => ({ name: e.name || e.id, hidden: isHidden(e) })),
    unlabelled,
    claims,
  };
}

async function runPage(browser, path, vp, res, shotDir) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: 'light' });
  await ctx.addInitScript(() => {
    window.__cls = 0;
    window.__shifts = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.hadRecentInput) continue;
          window.__cls += e.value;
          window.__shifts.push({ v: +e.value.toFixed(3), t: Math.round(e.startTime), s: (e.sources || []).slice(0, 3).map((x) => {
            const n = x.node;
            const name = n && n.nodeType === 1 ? `${n.tagName.toLowerCase()}.${String(n.className || '').split(' ')[0]}` : '?';
            return `${name} y${Math.round(x.previousRect.y)}->${Math.round(x.currentRect.y)} h${Math.round(x.previousRect.height)}->${Math.round(x.currentRect.height)}`;
          }) });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      // layout-shift not supported: CLS check will read 0
    }
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push({ text: m.text(), url: m.location()?.url || '' });
  });

  const resp = await page.goto(args.base + path, { waitUntil: 'load', timeout: 60000 });
  const status = resp ? resp.status() : 0;
  add(res, 'http', status === 200 ? 'pass' : 'fail', `status ${status}`);

  const cls0 = await page.evaluate(() => window.__cls);
  await page.waitForTimeout(3000);
  const cls1 = await page.evaluate(() => window.__cls);
  const cls = cls1 - cls0;
  const shifts = await page.evaluate(() => window.__shifts || []);
  const top = shifts.sort((a, b) => b.v - a.v).slice(0, 3).map((x) => `${x.v}@${x.t}ms ${x.s.join(' & ')}`).join(' || ');
  add(res, 'cls-3s', cls <= 0.1 ? 'pass' : 'fail', `CLS ${cls.toFixed(3)} over 3 s after load (limit 0.1)${cls > 0.1 ? ` worst: ${top}` : ''}`);

  add(res, 'page-errors', pageErrors.length ? 'fail' : 'pass', pageErrors.join(' | ') || 'none');
  const bad = consoleErrors.filter(isBadConsole);
  add(res, 'console-errors', bad.length ? 'fail' : 'pass',
    bad.slice(0, 3).map((c) => `${c.text.slice(0, 120)} @${c.url}`).join(' | ') || 'none');

  const m = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
    dir: document.documentElement.getAttribute('dir'),
    h1: document.querySelectorAll('h1').length,
    noAlt: [...document.images].filter((i) => !i.hasAttribute('alt')).map((i) => i.getAttribute('src') || '(no src)'),
  }));
  const small = await page.evaluate(smallTargets);

  add(res, 'overflow-x', m.sw <= m.iw ? 'pass' : 'fail', `scrollWidth ${m.sw} vs innerWidth ${m.iw}`);
  const wantDir = RTL_PATH.test(path) ? 'rtl' : 'ltr';
  add(res, 'html-dir', m.dir === wantDir ? 'pass' : 'fail', `dir=${m.dir} expected ${wantDir}`);
  add(res, 'one-h1', m.h1 === 1 ? 'pass' : 'fail', `${m.h1} h1 elements`);
  add(res, 'img-alt', m.noAlt.length ? 'fail' : 'pass', m.noAlt.slice(0, 3).join(', ') || 'all images have alt');
  if (small.length) add(res, 'tap-targets', 'warn', `${small.length} under 44px: ${small.slice(0, 5).join('; ')}`);
  else add(res, 'tap-targets', 'pass', 'none under 44px in first viewport');

  try {
    const axe = await new AxeBuilder({ page }).analyze();
    const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    const minor = axe.violations.filter((v) => !serious.includes(v));
    add(res, 'axe-serious', serious.length ? 'fail' : 'pass',
      serious.map((v) => `${v.id}(${v.impact}, ${v.nodes.length} nodes: ${v.nodes.slice(0, 3).map((nd) => `${nd.target.join(' ')} ${String(nd.any?.[0]?.message || '').replace(/\s+/g, ' ').slice(0, 110)}`).join(' ; ')})`).join(', ') || 'none');
    if (minor.length) add(res, 'axe-minor', 'warn', minor.map((v) => `${v.id}(${v.impact})`).join(', '));
  } catch (e) {
    add(res, 'axe-serious', 'fail', `axe could not run: ${e.message.split('\n')[0]}`);
  }

  const consent = await page.evaluate(() => {
    const s = [...document.head.querySelectorAll('script')];
    const t = s.findIndex((e) => /gtag|adsbygoogle|googletagmanager/i.test(`${e.textContent || ''} ${e.getAttribute('src') || ''}`));
    const c = s.findIndex((e) => /consent/i.test(e.textContent || '') && /default/i.test(e.textContent || ''));
    return { t, c };
  });
  if (consent.t < 0) add(res, 'consent-order', 'pass', 'no tracker script in head');
  else if (consent.c < 0 || consent.c > consent.t) {
    add(res, 'consent-order', 'fail', `first tracker is head script ${consent.t}, consent default is ${consent.c}`);
  } else add(res, 'consent-order', 'pass', `consent default ${consent.c} before tracker ${consent.t}`);

  const vpName = `${vp.w}x${vp.h}`;
  const slug = path.replace(/^\//, '').replace(/\//g, '_');
  await page.screenshot({ path: join(shotDir, `${slug}-${vpName}.png`), fullPage: true });

  if (path === '/news') {
    const btn = page.locator('button[aria-controls]').first();
    if ((await btn.count()) === 0) {
      add(res, 'card-expand', 'fail', 'no button[aria-controls] on /news');
    } else {
      const before = await btn.getAttribute('aria-expanded');
      const pathBefore = new URL(page.url()).pathname;
      try {
        await btn.click({ timeout: 10000 });
        await page.waitForTimeout(400);
        const after = await btn.getAttribute('aria-expanded');
        const pathAfter = new URL(page.url()).pathname;
        const ok = before !== after && after === 'true' && pathBefore === pathAfter;
        add(res, 'card-expand', ok ? 'pass' : 'fail', `aria-expanded ${before} -> ${after}; path ${pathBefore} -> ${pathAfter}`);
        await page.screenshot({ path: join(shotDir, `${slug}-${vpName}-expanded.png`), fullPage: true });
      } catch (e) {
        add(res, 'card-expand', 'fail', `click failed: ${e.message.split('\n')[0]}`);
      }
    }
  }

  if (path === '/advertise') {
    const f = await page.evaluate(advertiseForm);
    if (!f.forms) add(res, 'form-present', 'fail', 'no <form> on /advertise');
    add(res, 'form-labels', f.unlabelled.length ? 'fail' : 'pass',
      f.unlabelled.length ? `unlabelled: ${f.unlabelled.join(', ')}` : `${f.fields} fields labelled`);
    if (!f.honey.length) {
      add(res, 'honeypot', 'warn', 'no honeypot field identified by name (honey|hp|trap|bot)');
    } else {
      const visible = f.honey.filter((h) => !h.hidden);
      add(res, 'honeypot', visible.length ? 'fail' : 'pass',
        visible.length ? `visible: ${visible.map((h) => h.name).join(', ')}` : `hidden: ${f.honey.map((h) => h.name).join(', ')}`);
    }
    add(res, 'no-invented-claims', f.claims.length ? 'fail' : 'pass', f.claims.join(' | ') || 'no % or million');
  }
  await ctx.close();
}

async function main() {
  const shots = join(args.out, 'screenshots');
  mkdirSync(shots, { recursive: true });
  const results = [];
  const browser = await chromium.launch();
  try {
    for (const path of PAGES) {
      for (const vp of VIEWPORTS) {
        const res = { page: path, viewport: `${vp.w}x${vp.h}`, checks: [] };
        results.push(res);
        try {
          await runPage(browser, path, vp, res, shots);
        } catch (e) {
          add(res, 'navigation', 'fail', e.message.split('\n')[0]);
        }
      }
    }
  } finally {
    await browser.close();
  }

  const failures = [];
  const warnings = [];
  let pass = 0;
  for (const r of results) {
    for (const c of r.checks) {
      const tag = `${r.page} ${r.viewport} ${c.id}`;
      if (c.status === 'fail') failures.push(`${tag}: ${c.detail}`);
      else if (c.status === 'warn') warnings.push(`${tag}: ${c.detail}`);
      else pass += 1;
    }
  }
  const out = { generatedAt: new Date().toISOString(), base: args.base, pass, warn: warnings.length, fail: failures.length, failures, warnings, results };
  writeFileSync(join(args.out, 'browser_results.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`browser QA: ${pass} pass, ${warnings.length} warn, ${failures.length} fail`);
  for (const f of failures) console.log(`FAIL ${f}`);
  for (const w of warnings.slice(0, 60)) console.log(`WARN ${w}`);
  return failures.length ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => {
  console.error(`browser QA crashed: ${e.message.split('\n')[0]}`);
  process.exit(1);
});
