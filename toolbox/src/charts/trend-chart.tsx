import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface TrendSeries {
  key: string;
  label: string;
  color?: string;
}

export function TrendChart<T extends Record<string, unknown>>({
  data,
  xKey,
  series,
  height = 280,
}: {
  data: T[];
  xKey: string;
  series: TrendSeries[];
  height?: number;
}) {
  const palette = ['var(--tb-brand-500)', 'var(--tb-info)', 'var(--tb-warning)', 'var(--tb-danger)'];
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
        <CartesianGrid stroke="var(--tb-border)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey={xKey} stroke="var(--tb-text-muted)" fontSize={12} tickLine={false} />
        <YAxis stroke="var(--tb-text-muted)" fontSize={12} tickLine={false} axisLine={false} />
        <Tooltip
          contentStyle={{
            background: 'var(--tb-surface)',
            border: '1px solid var(--tb-border)',
            borderRadius: 'var(--tb-radius-md)',
            fontSize: 12,
          }}
        />
        {series.map((item, index) => (
          <Line
            key={item.key}
            type="monotone"
            dataKey={item.key}
            name={item.label}
            stroke={item.color ?? palette[index % palette.length]}
            strokeWidth={2}
            dot={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
