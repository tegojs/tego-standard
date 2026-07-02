import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Grid drag-and-drop context', () => {
  it('uses the schema dnd context so designer drags update schema layout', () => {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(currentDir, '../Grid.tsx'), 'utf8');

    expect(source).toContain("import { DndContext } from '../../common/dnd-context';");
    expect(source).not.toMatch(/import\s+\{[^}]*\bDndContext\b[^}]*\}\s+from '@dnd-kit\/core'/);
  });
});
