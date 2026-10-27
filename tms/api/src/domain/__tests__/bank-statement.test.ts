import { describe, expect, it } from 'vitest';
import { parseAmount, parseDate, parseStatement, StatementError } from '../bank-statement';

describe('parseAmount', () => {
  it.each([
    ['1500.00', 150000],
    ['1 500.00', 150000],
    ['R1,500.00', 150000],
    ['1500,00', 150000],
    ['1.500,50', 150050],
    ['-250.00', -25000],
    ['(250.00)', -25000],
    ['250.00 Dr', -25000],
    ['250.00Cr', 25000],
    ['8500', 850000],
    ['+8500.5', 850050],
  ])('%s is %i cents', (raw, cents) => {
    expect(parseAmount(raw)).toBe(cents);
  });

  it.each(['', 'abc', '12.345', '1-2'])('%s is not an amount', (raw) => {
    expect(parseAmount(raw)).toBeNull();
  });
});

describe('parseDate', () => {
  it.each([
    ['2026-10-01', '2026-10-01'],
    ['2026/10/01', '2026-10-01'],
    ['01/10/2026', '2026-10-01'],
    ['1-10-2026', '2026-10-01'],
    ['20261001', '2026-10-01'],
    ['20261001120000[+2:SAST]', '2026-10-01'],
    ['01 Oct 2026', '2026-10-01'],
    ['1 October 2026', '2026-10-01'],
  ])('%s is %s', (raw, iso) => {
    expect(parseDate(raw)).toBe(iso);
  });

  it('refuses a day that does not exist', () => {
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('2026-13-01')).toBeNull();
  });
});

describe('parseStatement', () => {
  it('reads FNB: account details above the header, one signed amount', () => {
    const csv = [
      'ACC-NO,62000000000,Mokoena Properties',
      'Opening Balance,25000.00',
      'Date,Amount,Balance,Description',
      '2026/10/01,8500.00,33500.00,"FNB APP PAYMENT FROM N PHIRI LSE-00101"',
      '2026/10/02,-450.00,33050.00,"POS PURCHASE BUILDERS"',
    ].join('\n');
    const parsed = parseStatement('fnb.csv', csv);
    expect(parsed.format).toBe('csv');
    expect(parsed.debitsSkipped).toBe(1);
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]).toMatchObject({
      postedOn: '2026-10-01',
      amountCents: 850000,
      description: 'FNB APP PAYMENT FROM N PHIRI LSE-00101',
    });
  });

  it('reads Capitec: separate money in and money out, two description columns', () => {
    const csv = [
      'Nr,Account,Posting Date,Transaction Date,Description,Original Description,Parent Category,Category,Money In,Money Out,Fee,Balance',
      '1,1234,2026-10-01,2026-10-01,Payment Received: S Mahlangu,Payment Received: S Mahlangu,Income,Rent,7200.00,,,10000.00',
      '2,1234,2026-10-02,2026-10-02,Electricity,Prepaid Electricity,Home,Utilities,,-300.00,,9700.00',
    ].join('\n');
    const parsed = parseStatement('capitec.csv', csv);
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]!.amountCents).toBe(720000);
    expect(parsed.lines[0]!.description).toBe('Payment Received: S Mahlangu');
    expect(parsed.debitsSkipped).toBe(1);
  });

  it('reads semicolons and decimal commas', () => {
    const csv = 'Datum;Beskrywing;Bedrag\n01/10/2026;Huur LSE 101;8500,00\n';
    const parsed = parseStatement('nedbank.csv', csv);
    expect(parsed.lines[0]).toMatchObject({ postedOn: '2026-10-01', amountCents: 850000 });
  });

  it('reads a file with no header from its values', () => {
    const csv = '01/10/2026,8500.00,DEPOSIT N PHIRI\n02/10/2026,-100.00,BANK FEES\n';
    const parsed = parseStatement('export.csv', csv);
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]!.description).toBe('DEPOSIT N PHIRI');
  });

  it('reads OFX 1.x with unclosed tags, and keys lines on FITID', () => {
    const ofx = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261001<TRNAMT>8500.00<FITID>A1<NAME>N PHIRI<MEMO>LSE-00101 &amp; Oct
</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261002<TRNAMT>-50.00<FITID>A2<NAME>FEE
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const parsed = parseStatement('statement.ofx', ofx);
    expect(parsed.format).toBe('ofx');
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]!.description).toBe('N PHIRI LSE-00101 & Oct');
    const again = parseStatement('statement.ofx', ofx.replace('N PHIRI', 'N. PHIRI'));
    expect(again.lines[0]!.fingerprint).toBe(parsed.lines[0]!.fingerprint);
  });

  it('keeps two identical credits apart, and gives them the same fingerprints next time', () => {
    const csv = 'Date,Amount,Description\n2026-10-01,7000.00,CASH DEPOSIT\n2026-10-01,7000.00,CASH DEPOSIT\n';
    const first = parseStatement('a.csv', csv);
    const second = parseStatement('b.csv', `${csv}2026-10-02,100.00,OTHER\n`);
    expect(first.lines).toHaveLength(2);
    expect(first.lines[0]!.fingerprint).not.toBe(first.lines[1]!.fingerprint);
    expect(second.lines.slice(0, 2).map((line) => line.fingerprint)).toEqual(
      first.lines.map((line) => line.fingerprint),
    );
  });

  it('explains a file it cannot read', () => {
    expect(() => parseStatement('x.csv', 'hello,world\nfoo,bar')).toThrow(StatementError);
    expect(() => parseStatement('x.csv', 'Date,Amount\n2026-10-01,-5.00')).toThrow(/only payments out/);
  });
});
