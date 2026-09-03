import { describe, expect, it } from 'vitest';
import { normalizeCellRange, parseCsv, rangeToTsv, spreadsheetColumn } from '@/app/csvTable';

describe('CSV table', () => {
  it('parses quoted separators, escaped quotes and multiline cells', () => {
    const table = parseCsv('name,note\r\nAlice,"hello, ""world"""\r\nBob,"two\nlines"\r\n');
    expect(table.delimiter).toBe(',');
    expect(table.rows).toEqual([
      ['name', 'note'],
      ['Alice', 'hello, "world"'],
      ['Bob', 'two\nlines'],
    ]);
  });

  it('detects semicolon and tab-separated files', () => {
    expect(parseCsv('a;b;c\n1;2;3').delimiter).toBe(';');
    expect(parseCsv('a\tb\n1\t2').delimiter).toBe('\t');
  });

  it('normalizes reverse selections and copies a rectangle as TSV', () => {
    const range = { anchor: { row: 1, col: 2 }, focus: { row: 0, col: 1 } };
    expect(normalizeCellRange(range)).toEqual({ top: 0, bottom: 1, left: 1, right: 2 });
    expect(rangeToTsv([['a', 'b', 'c'], ['1', 'two\nlines', '3']], range))
      .toBe('b\tc\n"two\nlines"\t3');
  });

  it('names spreadsheet columns beyond Z', () => {
    expect([0, 25, 26, 27, 701].map(spreadsheetColumn)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ']);
  });
});
