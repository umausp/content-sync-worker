import { readFileSync } from 'node:fs';
import { IngestStoryRequestSchema } from './src/news.ts';

const file = process.argv[2];
const doc = JSON.parse(readFileSync(file, 'utf8'));
const stories: Array<Record<string, unknown>> = Array.isArray(doc) ? doc : doc.stories || [];
let bad = 0;
for (const s of stories) {
  // sourceText is a validator-only preview field, never part of the POST body.
  const { sourceText: _ignored, ...body } = s;
  const r = IngestStoryRequestSchema.safeParse(JSON.parse(JSON.stringify(body)));
  if (!r.success) {
    bad++;
    const why = r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ');
    console.log(`SCHEMA-FAIL #${String(s.hashtag)} ${why}`);
  }
}
console.log(`schema: ${stories.length - bad}/${stories.length} bodies valid`);
process.exit(bad ? 1 : 0);
