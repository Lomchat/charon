export type CsvTable = {
  rows: string[][];
  delimiter: ',' | ';' | '\t' | '|';
  columns: number;
  truncated: boolean;
};

export type Cell = { row: number; col: number };
export type CellRange = { anchor: Cell; focus: Cell };

const CANDIDATES: CsvTable['delimiter'][] = [',', ';', '\t', '|'];
const MAX_ROWS = 50_000;
const MAX_COLUMNS = 500;
const MAX_CELLS = 1_000_000;

function parseWith(text: string, delimiter: CsvTable['delimiter'], rowLimit = MAX_ROWS): CsvTable {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!input) return { rows: [], delimiter, columns: 0, truncated: false };
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let truncated = false;
  let cells = 0;

  const pushField = () => {
    if (row.length < MAX_COLUMNS && cells < MAX_CELLS) {
      row.push(field);
      cells++;
    } else {
      truncated = true;
    }
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (rows.length < rowLimit && cells <= MAX_CELLS) rows.push(row);
    else truncated = true;
    row = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.length === 0) { quoted = true; continue; }
    if (ch === delimiter) { pushField(); continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      pushRow();
      if (rows.length >= rowLimit || cells >= MAX_CELLS) {
        if (i < input.length - 1) truncated = true;
        break;
      }
      continue;
    }
    field += ch;
  }
  const last = input[input.length - 1];
  if (row.length > 0 || field.length > 0 || last === delimiter) pushRow();
  const columns = rows.reduce((max, current) => Math.max(max, current.length), 0);
  return { rows, delimiter, columns, truncated };
}

function delimiterScore(table: CsvTable): number {
  const sample = table.rows.filter((row) => row.some((cell) => cell.length > 0)).slice(0, 30);
  if (!sample.length) return 0;
  const counts = new Map<number, number>();
  for (const row of sample) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
  let modeColumns = 1;
  let modeCount = 0;
  for (const [columns, count] of counts) {
    if (columns > 1 && count > modeCount) { modeColumns = columns; modeCount = count; }
  }
  return modeColumns === 1 ? 0 : modeCount * 1_000 + modeColumns;
}

/** RFC-style quoted fields/newlines plus pragmatic delimiter detection. */
export function parseCsv(text: string, preferred?: CsvTable['delimiter']): CsvTable {
  if (preferred) return parseWith(text, preferred);
  let best = parseWith(text, ',', 30);
  let score = delimiterScore(best);
  for (const delimiter of CANDIDATES.slice(1)) {
    const candidate = parseWith(text, delimiter, 30);
    const candidateScore = delimiterScore(candidate);
    if (candidateScore > score) { best = candidate; score = candidateScore; }
  }
  return parseWith(text, best.delimiter);
}

export function normalizeCellRange(range: CellRange): { top: number; bottom: number; left: number; right: number } {
  return {
    top: Math.min(range.anchor.row, range.focus.row),
    bottom: Math.max(range.anchor.row, range.focus.row),
    left: Math.min(range.anchor.col, range.focus.col),
    right: Math.max(range.anchor.col, range.focus.col),
  };
}

export function cellInRange(row: number, col: number, range: CellRange | null): boolean {
  if (!range) return false;
  const r = normalizeCellRange(range);
  return row >= r.top && row <= r.bottom && col >= r.left && col <= r.right;
}

function tsvCell(value: string): string {
  return /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Clipboard shape understood by Google Sheets, Excel and LibreOffice. */
export function rangeToTsv(rows: string[][], range: CellRange): string {
  const r = normalizeCellRange(range);
  const out: string[] = [];
  for (let row = r.top; row <= r.bottom; row++) {
    const values: string[] = [];
    for (let col = r.left; col <= r.right; col++) values.push(tsvCell(rows[row]?.[col] ?? ''));
    out.push(values.join('\t'));
  }
  return out.join('\n');
}

export function spreadsheetColumn(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    n--;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}
