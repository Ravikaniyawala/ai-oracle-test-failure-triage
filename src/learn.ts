import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const DB_PATH = process.env['ORACLE_STATE_DB_PATH'] ?? './oracle-state.db';
const INSTINCTS_DIR = './.instincts';

interface PatternRow {
  error_hash:   string;
  category:     string;
  count:        number;
  avg_confidence: number;
  suggested_fix: string;
  last_seen:    string;
}

function main(): void {
  try {
    if (!existsSync(DB_PATH)) {
      console.log('[learn] no SQLite DB found, nothing to learn from');
      process.exit(0);
    }

    const db = new Database(DB_PATH, { readonly: true });

    if (!existsSync(INSTINCTS_DIR)) {
      mkdirSync(INSTINCTS_DIR, { recursive: true });
    }

    const patterns = db.prepare(`
      SELECT
        f.error_hash,
        f.category,
        COUNT(*) as count,
        AVG(f.confidence) as avg_confidence,
        f.test_name as suggested_fix,
        MAX(r.timestamp) as last_seen
      FROM failures f
      JOIN runs r ON r.id = f.run_id
      GROUP BY f.error_hash, f.category
      HAVING COUNT(*) >= 3 AND AVG(f.confidence) > 0.7
      ORDER BY count DESC
    `).all() as PatternRow[];

    let written = 0;
    for (const pattern of patterns) {
      const filePath = join(INSTINCTS_DIR, `${pattern.error_hash}.md`);
      if (existsSync(filePath)) continue;

      const content = `---
id: ${pattern.error_hash}
category: ${pattern.category}
confidence: ${pattern.avg_confidence.toFixed(2)}
seen: ${pattern.count}
last_seen: ${pattern.last_seen}
---

## Pattern
- Error hash ${pattern.error_hash} consistently classified as ${pattern.category} (seen ${pattern.count} times, avg confidence ${(pattern.avg_confidence * 100).toFixed(0)}%)

## Action
- ${pattern.category === 'FLAKY' ? 'Auto-retry or stabilise the test — this is a known flaky pattern' : pattern.category === 'ENV_ISSUE' ? 'Check CI environment configuration — this is a recurring environment issue' : pattern.category === 'REGRESSION' ? 'Investigate recent code changes — this pattern indicates a regression' : 'Review and fix — this is a recurring new bug pattern'}
`;

      writeFileSync(filePath, content, 'utf8');
      console.log(`[learn] wrote instinct: ${filePath}`);
      written++;
    }

    console.log(`[learn] done — ${written} new instinct(s) written, ${patterns.length} total patterns found`);
    db.close();
  } catch (err) {
    console.error('[learn] error:', err);
  }
  process.exit(0);
}

main();
