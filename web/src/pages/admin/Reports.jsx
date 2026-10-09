import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, Printer, FileSpreadsheet, FileText } from 'lucide-react';
import { api, download, qs } from '../../lib/api.js';
import { money, int, dt } from '../../lib/format.js';
import { Button, PageHeader, useLoad, Card, Chips, Input, Table, Pager, Skeleton, ErrorState, Kv, Select } from '../../components/ui.jsx';
import { browserPrint } from '../../lib/printer.js';
import { useAuth } from '../../lib/auth.jsx';

const RANGES = [{ value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'week', label: 'This week' }, { value: 'month', label: 'This month' }, { value: 'custom', label: 'Custom' }];
const fmt = (type, v) => (v == null || v === '' ? '' : type === 'money' ? money(v) : type === 'int' ? int(v) : type === 'datetime' ? dt(v) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));

export default function Reports() {
  const { can, settings } = useAuth();
  const [sp, setSp] = useSearchParams();
  const list = useLoad(() => api.get('/reports'), []);
  const [key, setKey] = useState(sp.get('key') || 'sales');
  const [f, setF] = useState({ range: 'today', from: '', to: '' });
  const [page, setPage] = useState(1);
  const branches = useLoad(() => api.get('/branches'), []);
  const staff = useLoad(() => api.get('/staff?pageSize=200').catch(() => ({ items: [] })), []);
  const machines = useLoad(() => api.get('/machines?pageSize=200').catch(() => ({ items: [] })), []);
  const tiers = useLoad(() => api.get('/tiers'), []);
  useEffect(() => setPage(1), [key, JSON.stringify(f)]);
  const params = { ...f, from: f.range === 'custom' ? f.from : undefined, to: f.range === 'custom' ? f.to : undefined };
  const st = useLoad(() => api.get(`/reports/${key}${qs({ ...params, page, pageSize: 100 })}`), [key, JSON.stringify(f), page]);
  const exp = (format) => download(`/reports/${key}${qs({ ...params, format })}`, `${key}.${format}`);
  const set = (k) => (e) => setF({ ...f, [k]: e.target ? e.target.value : e });
  const opt = (s, label = 'name') => (s.data?.items || []).map((x) => ({ value: x.id, label: x[label] || `${x.first_name} ${x.last_name}` }));
  return (
    <div>
      <PageHeader title="Reports" subtitle="Computed live from the ledger, orders and payments" actions={can('report.export') && <><Button icon={FileText} onClick={() => exp('csv')}>CSV</Button><Button icon={FileSpreadsheet} onClick={() => exp('xlsx')}>Excel</Button><Button icon={Printer} onClick={() => browserPrint('report-print')}>Print / PDF</Button></>} />
      <div className="row wrap mb"><Chips options={(list.data?.items || []).map((r) => ({ value: r.key, label: r.label.replace(' Report', '') }))} value={key} onChange={(k) => { setKey(k); setSp({ key: k }); }} /></div>
      <Card className="mb">
        <div className="row wrap">
          <Chips options={RANGES} value={f.range} onChange={set('range')} />
          {f.range === 'custom' && <><Input type="date" value={f.from} onChange={set('from')} /><Input type="date" value={f.to} onChange={set('to')} /></>}
          <div style={{ width: 170 }}><Select value={f.branchId || ''} onChange={set('branchId')} placeholder="All branches" options={opt(branches)} /></div>
          <div style={{ width: 170 }}><Select value={f.staffId || ''} onChange={set('staffId')} placeholder="All staff" options={opt(staff)} /></div>
          {['arcade', 'transactions', 'point', 'stamp'].includes(key) && <div style={{ width: 170 }}><Select value={f.machineId || ''} onChange={set('machineId')} placeholder="All machines" options={opt(machines)} /></div>}
          {['member', 'point', 'stamp', 'transactions'].includes(key) && <div style={{ width: 150 }}><Select value={f.tierId || ''} onChange={set('tierId')} placeholder="All tiers" options={opt(tiers)} /></div>}
          {['sales', 'topup', 'payment'].includes(key) && <div style={{ width: 160 }}><Select value={f.method || ''} onChange={set('method')} placeholder="All payments" options={['CASH', 'PROMPTPAY', 'BANK_TRANSFER', 'CREDIT_CARD', 'DEBIT_CARD', 'E_WALLET', 'GATEWAY', 'CARD_BALANCE', 'OTHER']} /></div>}
          {key === 'transactions' && <div style={{ width: 170 }}><Select value={f.type || ''} onChange={set('type')} placeholder="All types" options={['TOP_UP', 'PLAY', 'FOOD_PURCHASE', 'REFUND', 'BALANCE_ADJUSTMENT', 'STAMP_ADD', 'STAMP_REMOVE', 'POINT_ADD', 'POINT_REMOVE', 'REWARD_REDEMPTION', 'CARD_DEPOSIT', 'DEPOSIT_REFUND']} /></div>}
          {key === 'member' && <label className="check"><input type="checkbox" checked={f.joined === '1'} onChange={(e) => setF({ ...f, joined: e.target.checked ? '1' : '' })} />Joined in period</label>}
        </div>
      </Card>
      {st.error ? <ErrorState error={st.error} onRetry={st.reload} /> : !st.data ? <Skeleton rows={8} /> : (
        <div id="report-print" style={{ background: 'var(--surface)' }}>
          <div className="print-only"><h2>{settings?.general?.storeName} — {st.data.label}</h2><div className="small">{f.range} {f.from} {f.to} · printed {new Date().toLocaleString('en-GB')}</div></div>
          <Card title={st.data.label} className="mb"><Kv items={Object.entries(st.data.summary || {}).map(([k, v]) => [k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' '), typeof v === 'number' && /amount|paid|total|spend|topup|liability|revenue|gross|net|refund|bonus|balance|credited|cards$|deposits|settlement|vat|discount|method/i.test(k) && !/^(count|orders|uses|plays|members|machines|online|shifts|confirmed|cards)$/i.test(k) ? money(v) : typeof v === 'boolean' ? (v ? '✓ yes' : '✗ NO') : String(v)])} /></Card>
          <div className="card pad-0"><Table rowKey="__i" columns={st.data.columns.map((c) => ({ key: c.key, label: c.label, num: ['money', 'int'].includes(c.type), render: (r) => fmt(c.type, r[c.key]) }))} rows={st.data.rows.map((r, i) => ({ ...r, __i: i }))} />
            <Pager page={st.data.page} pages={Math.max(1, Math.ceil(st.data.total / st.data.pageSize))} total={st.data.total} onPage={setPage} /></div>
        </div>
      )}
      <span hidden><Download /></span>
    </div>
  );
}
