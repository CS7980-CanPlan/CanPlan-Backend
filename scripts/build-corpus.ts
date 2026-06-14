import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

interface CorpusLine {
  chunk_id: string;
  text: string;
  category: string;
  source: { title: string; citation: string; url?: string };
}

export interface CorpusFile {
  key: string;
  body: string;
}

/** Map corpus lines to the per-passage S3 file pair (body + .metadata.json). */
export function toCorpusFiles(lines: CorpusLine[]): CorpusFile[] {
  const files: CorpusFile[] = [];
  for (const l of lines) {
    const key = `${l.chunk_id}.txt`;
    files.push({ key, body: l.text });
    files.push({
      key: `${key}.metadata.json`,
      body: JSON.stringify({
        metadataAttributes: {
          chunk_id: l.chunk_id,
          category: l.category,
          title: l.source.title,
          url: l.source.url,
          citation: l.source.citation,
        },
      }),
    });
  }
  return files;
}

// CLI: `npx ts-node scripts/build-corpus.ts` → writes data/corpus/dist/
if (require.main === module) {
  const inPath = join(__dirname, '../data/corpus/seed.jsonl');
  const outDir = join(__dirname, '../data/corpus/dist');
  const lines = readFileSync(inPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CorpusLine);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const f of toCorpusFiles(lines)) {
    writeFileSync(join(outDir, f.key), f.body);
  }
  console.log(`wrote ${toCorpusFiles(lines).length} files for ${lines.length} passages to ${outDir}`);
}
