import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('workflow approval debug output hygiene', () => {
  it('should not write directly to console from approval instruction', () => {
    const source = readFileSync(join(__dirname, '../instructions/Approval.ts'), 'utf8');

    expect(source).not.toContain('console.log');
  });
});
