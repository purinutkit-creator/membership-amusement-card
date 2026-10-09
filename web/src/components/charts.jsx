// Chart wrappers: thin marks, recessive grid, one y-axis per chart, hover tooltips by default.
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { Empty } from './ui.jsx';

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)', 'var(--series-7)'];
const axis = { stroke: 'var(--axis)', fontSize: 12, tickLine: false, axisLine: false };
/** Compact numeric axis ticks (units live in the chart title / tooltip). */
export const axisFmt = (v) => { const n = Number(v); const a = Math.abs(n); return a >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : a >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(+n.toFixed(2)); };

function Tip({ active, payload, label, fmt }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <div className="bold">{label}</div>
      {payload.map((p) => <div key={p.dataKey} className="row gap-s"><span className="dot" style={{ background: p.color }} /><span className="k">{p.name}</span><b className="num">{fmt ? fmt(p.value) : p.value}</b></div>)}
    </div>
  );
}

/** series: [{ key, name }] — legend shown when >1 series. */
export function BarsChart({ data, x, series, height = 240, fmt, horizontal }) {
  if (!data?.length) return <Empty title="No data for this period" />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 12, left: horizontal ? 8 : -8, bottom: 0 }} barCategoryGap="22%">
        <CartesianGrid stroke="var(--grid)" vertical={!!horizontal} horizontal={!horizontal} />
        {horizontal ? <><XAxis type="number" {...axis} tickFormatter={axisFmt} /><YAxis type="category" dataKey={x} {...axis} width={120} /></>
          : <><XAxis dataKey={x} {...axis} /><YAxis {...axis} tickFormatter={axisFmt} width={48} /></>}
        <Tooltip content={<Tip fmt={fmt} />} cursor={{ fill: 'var(--surface-2)' }} />
        {series.length > 1 && <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />}
        {series.map((s, i) => <Bar key={s.key} dataKey={s.key} name={s.name} fill={SERIES[i]} radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={36} stroke="var(--surface)" strokeWidth={series.length > 1 ? 2 : 0} />)}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function LinesChart({ data, x, series, height = 240, fmt }) {
  if (!data?.length) return <Empty title="No data for this period" />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey={x} {...axis} /><YAxis {...axis} tickFormatter={axisFmt} width={48} />
        <Tooltip content={<Tip fmt={fmt} />} cursor={{ stroke: 'var(--axis)', strokeDasharray: '3 3' }} />
        {series.length > 1 && <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />}
        {series.map((s, i) => <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={SERIES[i]} strokeWidth={2} dot={false} activeDot={{ r: 5, stroke: 'var(--surface)', strokeWidth: 2 }} />)}
      </LineChart>
    </ResponsiveContainer>
  );
}
