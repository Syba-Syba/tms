import { describe, expect, it } from 'vitest';
import { csvCell, csvText } from '../csv';

describe('csvCell', () => {
  it('quotes every cell and doubles quotes inside it', () => {
    expect(csvCell('Naledi')).toBe('"Naledi"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(12)).toBe('"12"');
  });

  it('neutralises cells a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell('+27 82 000 1111')).toBe(`"'+27 82 000 1111"`);
    expect(csvCell('-cmd')).toBe(`"'-cmd"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('\tx')).toBe(`"'\tx"`);
    expect(csvCell('\rx')).toBe(`"'\rx"`);
  });

  it('leaves plain numbers numeric, negative ones included', () => {
    expect(csvCell('-500.00')).toBe('"-500.00"');
    expect(csvCell(-500)).toBe('"-500"');
    expect(csvCell('+12.5')).toBe('"+12.5"');
    expect(csvCell('1500.00')).toBe('"1500.00"');
  });

  it('joins rows with commas and lines with newlines', () => {
    expect(csvText([['a', 1], ['=b', -2]])).toBe(`"a","1"\n"'=b","-2"`);
  });
});
