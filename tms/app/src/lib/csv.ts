/**
 * CSV for spreadsheets. Every cell is quoted, and a text cell that starts with = + - @, a tab
 * or a carriage return gets a leading apostrophe: Excel and Google Sheets run such a cell as a
 * formula, so a tenant named =HYPERLINK(...) would run code on the landlord's machine. A plain
 * number such as -500.00 is left alone so it still sums.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

export function csvCell(value: string | number): string {
  let text = String(value);
  if (FORMULA_START.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Rows of cells → the text of a CSV file. */
export const csvText = (rows: (string | number)[][]): string =>
  rows.map((row) => row.map(csvCell).join(',')).join('\n');

/** Saves rows as a CSV download in the browser. */
export function downloadCsv(name: string, rows: (string | number)[][]) {
  const url = URL.createObjectURL(new Blob([csvText(rows)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
