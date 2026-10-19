#!/usr/bin/env node
// Collects qa-out/result_<section>.json into qa_summary.md and qa_summary.json and prints the table.
// Usage: node .github/qa/summary.mjs [qaOutDir]. Exit 0 always; the overall verdict is in qa_summary.json.overall.
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] || process.env.QA_OUT || join(process.cwd(), 'qa-out');
const wanted = (process.env.QA_SECTIONS || 'pipeline,dryrun,site,browser').split(',').map((s) => s.trim()).filter(Boolean);
const rows = wanted.map((section) => {
  const f = join(out, `result_${section}.json`);
  if (!existsSync(f)) return { section, status: 'FAIL', detail: 'no result file: section script crashed', warnings: [] };
  return JSON.parse(readFileSync(f, 'utf8'));
});
const overall = rows.some((r) => r.status === 'FAIL') ? 'FAIL' : 'PASS';
const knobs = ['QA_PIPELINE_REF', 'QA_PIPELINE_BASE', 'QA_SITE_REF', 'QA_SITE_BASE', 'QA_EDITIONS', 'QA_SECTIONS', 'QA_VALIDATOR_MODEL']
  .map((k) => `${k}=${process.env[k] || '(default)'}`).join(', ');
const md = [
  '# circleci-qa summary', '', `Overall: **${overall}**`, '', `Knobs: ${knobs}`, '',
  '| Section | Status | Detail |', '|---|---|---|',
  ...rows.map((r) => `| ${r.section} | ${r.status} | ${String(r.detail).replace(/\|/g, '/').replace(/\n/g, ' ')} |`),
  '', '## Warnings', ...(rows.flatMap((r) => r.warnings.map((w) => `- [${r.section}] ${w}`)).length
    ? rows.flatMap((r) => r.warnings.map((w) => `- [${r.section}] ${w}`)) : ['- none']),
  '',
].join('\n');
writeFileSync(join(out, 'qa_summary.md'), md);
writeFileSync(join(out, 'qa_summary.json'), JSON.stringify({ overall, generatedAt: new Date().toISOString(), sections: rows }, null, 2) + '\n');
for (const r of rows) console.log(`${r.status.padEnd(5)} ${r.section.padEnd(9)} ${r.detail}`);
console.log(`overall: ${overall}  (warnings: ${rows.reduce((n, r) => n + r.warnings.length, 0)})`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
