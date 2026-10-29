import { useState } from 'react';
import { Card, CardBody } from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';

export interface MonthTotal {
  month: string; // YYYY-MM
  invoicedCents: number;
  collectedCents: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const rands = (cents: number) => formatZar(cents / 100, cents % 100 !== 0);
const compact = (cents: number) => {
  const r = cents / 100;
  return r >= 1000 ? `R${Math.round(r / 1000)}K` : `R${Math.round(r)}`;
};

// Geometry, in viewBox units. The SVG scales to its card; bars keep their proportions.
const W = 380;
const H = 170;
const PAD = { top: 22, right: 4, bottom: 22, left: 38 };
const BAR = 20; // invoiced, the context
const INNER = 10; // collected, the point

/** Rounded at the data end, square on the baseline. */
const column = (x: number, y: number, width: number, height: number) => {
  if (height <= 0) return '';
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
};

const niceMax = (value: number) => {
  if (value <= 0) return 100_000;
  const step = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / step) * step;
};

/**
 * Rent collected each month against what was invoiced. Emphasis form: collected is the one
 * series in the accent, invoiced the grey it sits in. Every bar has a tooltip, the latest month
 * is labelled, and a table carries the same figures for screen readers.
 */
export function CollectionsChart({ months }: { months: MonthTotal[] }) {
  const [active, setActive] = useState<number | null>(null);
  if (months.length === 0) return null;

  const max = niceMax(Math.max(...months.flatMap((m) => [m.invoicedCents, m.collectedCents])));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slot = plotW / months.length;
  const y = (cents: number) => PAD.top + plotH - (cents / max) * plotH;
  const ticks = [0, max / 2, max];
  const latest = months[months.length - 1]!;
  const share = latest.invoicedCents > 0 ? Math.round((latest.collectedCents / latest.invoicedCents) * 100) : null;
  const shown = active === null ? null : months[active]!;

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div>
            <h2 className="text-lead font-semibold text-ink">Rent collected</h2>
            <p className="text-meta text-ink-muted">
              {share === null
                ? 'Nothing invoiced this month yet.'
                : `${rands(latest.collectedCents)} of ${rands(latest.invoicedCents)} this month, ${share}%.`}
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs text-ink-muted" aria-hidden>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[2px] bg-brand-500" />Collected</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[2px] bg-[var(--tb-chart-context)]" />Invoiced</span>
          </div>
        </div>

        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="group"
            aria-label={`Rent collected against invoiced, ${monthName(months[0]!.month)} to ${monthName(latest.month)}. Figures in the table below.`}>
            {ticks.map((tick) => (
              <g key={tick}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} stroke="var(--tb-border-soft)" strokeWidth={1} />
                <text x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--tb-text-muted)">
                  {compact(tick)}
                </text>
              </g>
            ))}
            {months.map((m, index) => {
              const cx = PAD.left + slot * index + slot / 2;
              const isLatest = index === months.length - 1;
              return (
                <g key={m.month} tabIndex={0} role="button"
                  aria-label={`${monthName(m.month)}: collected ${rands(m.collectedCents)} of ${rands(m.invoicedCents)} invoiced`}
                  onMouseEnter={() => setActive(index)} onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(index)} onBlur={() => setActive(null)}
                  className="cursor-default outline-none focus-visible:[&>rect:first-child]:stroke-[var(--tb-ring)]">
                  {/* The hit target is the whole slot, not the thin bar. */}
                  <rect x={cx - slot / 2} y={PAD.top} width={slot} height={plotH} fill="transparent" strokeWidth={2} rx={4} />
                  <path d={column(cx - BAR / 2, y(m.invoicedCents), BAR, y(0) - y(m.invoicedCents))} fill="var(--tb-chart-context)" />
                  <path d={column(cx - INNER / 2, y(m.collectedCents), INNER, y(0) - y(m.collectedCents))}
                    fill="var(--tb-brand-500)" opacity={active === null || active === index ? 1 : 0.55} />
                  <text x={cx} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--tb-text-muted)">
                    {MONTHS[Number(m.month.slice(5, 7)) - 1]}
                  </text>
                  {isLatest && m.collectedCents > 0 ? (
                    <text x={cx} y={Math.min(y(m.invoicedCents), y(m.collectedCents)) - 6} textAnchor="middle" fontSize={11}
                      fontWeight={600} fill="var(--tb-text)">
                      {compact(m.collectedCents)}
                    </text>
                  ) : null}
                </g>
              );
            })}
            <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--tb-border)" strokeWidth={1} />
          </svg>

          {shown && active !== null ? (
            <div aria-hidden
              className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded-sm border border-line bg-surface px-2.5 py-1.5 text-xs shadow-sm"
              style={{ left: `${((PAD.left + slot * active + slot / 2) / W) * 100}%` }}>
              <p className="font-semibold text-ink">{monthName(shown.month)}</p>
              <p className="text-ink-muted">Collected <span className="tabular-nums text-ink">{rands(shown.collectedCents)}</span></p>
              <p className="text-ink-muted">Invoiced <span className="tabular-nums text-ink">{rands(shown.invoicedCents)}</span></p>
            </div>
          ) : null}
        </div>

        <table className="sr-only">
          <caption>Rent collected and invoiced by month</caption>
          <thead><tr><th scope="col">Month</th><th scope="col">Collected</th><th scope="col">Invoiced</th></tr></thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.month}><th scope="row">{monthName(m.month)}</th><td>{rands(m.collectedCents)}</td><td>{rands(m.invoicedCents)}</td></tr>
            ))}
          </tbody>
        </table>
      </CardBody>
    </Card>
  );
}
