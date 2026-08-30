import { describe, expect, it } from 'vitest';
import { missingInstructionSymlink } from '../app/instructionSymlink';

describe('instruction symlink context action', () => {
  it('offers the exact missing provider counterpart in either direction', () => {
    expect(missingInstructionSymlink('AGENTS.md', ['AGENTS.md', 'src'])).toBe('CLAUDE.md');
    expect(missingInstructionSymlink('CLAUDE.md', ['CLAUDE.md', 'src'])).toBe('AGENTS.md');
  });

  it('is hidden as soon as the counterpart already exists, including a symlink row', () => {
    expect(missingInstructionSymlink('AGENTS.md', ['AGENTS.md', 'CLAUDE.md'])).toBeNull();
    expect(missingInstructionSymlink('CLAUDE.md', ['AGENTS.md', 'CLAUDE.md'])).toBeNull();
  });

  it('does not appear for lookalikes or differently-cased names', () => {
    expect(missingInstructionSymlink('agents.md', [])).toBeNull();
    expect(missingInstructionSymlink('CLAUDE.MD', [])).toBeNull();
    expect(missingInstructionSymlink('README.md', [])).toBeNull();
  });
});
