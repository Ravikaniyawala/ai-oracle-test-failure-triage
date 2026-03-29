import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

export function loadInstincts(instinctsDir = './.instincts'): string[] {
  if (!existsSync(instinctsDir)) return [];

  const instincts: string[] = [];
  const files = readdirSync(instinctsDir).filter(f => f.endsWith('.md'));

  for (const file of files) {
    const content = readFileSync(join(instinctsDir, file), 'utf8');
    let inSection = false;
    for (const line of content.split('\n')) {
      if (line.startsWith('## Pattern') || line.startsWith('## Action')) {
        inSection = true;
        continue;
      }
      if (line.startsWith('## ')) {
        inSection = false;
        continue;
      }
      if (inSection && line.trim().startsWith('-')) {
        instincts.push(line.trim());
      }
    }
  }

  return instincts;
}
