import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle, Inbox, RefreshCw, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { STATUS_TONE } from '../lib/format.js';
import { play } from '../lib/sound.js';

// ---------------------------------------------------------------- data hooks
/** Load data with loading / error / reload; deps re-trigger. */
export function useLoad(fn, deps = []) {
  const [state, set] = useState({ data: null, loading: true, error: null });
  const seq = useRef(0);
  const reload = useCallback(async (silent = false) => {
    const n = ++seq.current;
    if (!silent) set((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fn();
      if (n === seq.current) set({ data, loading: false, error: null });
      return data;
    } catch (error) {
      if (n === seq.current) set((s) => ({ ...s, loading: false, error }));
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload, setData: (d) => set((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}

/** Wrap an async action with busy state + toast on error. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, { success, error } = {}) => {
    setBusy(true);
    try {
      const r = await fn();
      if (success) { toast.success(typeof success === 'function' ? success(r) : success); play('success'); }
      return r;
    } catch (e) {
      toast.error(error || e.message);
      play('error');
      throw e;
    } finally { setBusy(false); }
  }, [toast]);
  return [run, busy];
}

export function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

// ---------------------------------------------------------------- toast
const ToastCtx = createContext(null);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((type, msg, timeout = 4500) => {
    const id = Math.random().toString(36).slice(2);
    setItems((x) => [...x, { id, type, msg }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), timeout);
  }, []);
  const api_ = useMemo(() => ({ success: (m) => push('success', m), error: (m) => push('error', m, 7000), info: (m) => push('info', m), warning: (m) => push('warning', m) }), [push]);
  const icons = { success: <CheckCircle2 size={20} color="var(--success)" />, error: <XCircle size={20} color="var(--danger)" />, warning: <AlertTriangle size={20} color="var(--warning)" />, info: <Info size={20} color="var(--info)" /> };
  return (
    <ToastCtx.Provider value={api_}>
      {children}
      <div className="toasts no-print" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>{icons[t.type]}<div className="grow">{t.msg}</div>
            <button className="btn ghost sm icon" onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))} aria-label="Dismiss"><X size={16} /></button></div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------------------------------------------------------------- primitives
export function Button({ children, icon: Icon, loading, variant, size, block, className = '', ...p }) {
  return (
    <button type="button" className={`btn ${variant || ''} ${size || ''} ${block ? 'block' : ''} ${className}`} disabled={loading || p.disabled} {...p}>
      {loading ? <Loader2 size={18} className="spin" style={{ animation: 'spin .7s linear infinite' }} /> : Icon ? <Icon size={size === 'sm' ? 16 : 18} /> : null}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children, className = '' }) {
  return <div className={`field ${className}`}>{label && <label>{label}</label>}{children}{error ? <span className="err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}</div>;
}
export function Input({ label, hint, error, className = '', size, ...p }) {
  return <Field label={label} hint={hint} error={error} className={className}><input className={`input ${size || ''} ${error ? 'invalid' : ''}`} {...p} /></Field>;
}
export function Textarea({ label, hint, className = '', ...p }) {
  return <Field label={label} hint={hint} className={className}><textarea className="input" {...p} /></Field>;
}
export function Select({ label, hint, options = [], placeholder, className = '', ...p }) {
  return (
    <Field label={label} hint={hint} className={className}>
      <select className="input" {...p}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>))}
      </select>
    </Field>
  );
}
export function Check({ label, ...p }) { return <label className="check"><input type="checkbox" {...p} />{label}</label>; }
export function Switch({ label, checked, onChange, hint }) {
  return (
    <label className="row between" style={{ cursor: 'pointer', minHeight: 40 }}>
      <span><span>{label}</span>{hint && <div className="xs faint">{hint}</div>}</span>
      <span className="switch"><input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} /><span /></span>
    </label>
  );
}
export function Badge({ children, tone }) { return <span className={`badge ${tone || ''}`}>{children}</span>; }
export function StatusBadge({ status }) { return <Badge tone={STATUS_TONE[status] ?? ''}>{status}</Badge>; }
export function Card({ title, actions, children, className = '', ...p }) {
  return <div className={`card ${className}`} {...p}>{(title || actions) && <div className="card-h"><h3>{title}</h3><div className="row">{actions}</div></div>}{children}</div>;
}
export function Stat({ label, value, sub, icon: Icon, tone }) {
  return <div className="card"><div className="stat"><span className="label">{Icon && <Icon size={16} />}{label}</span><span className={`value ${tone || ''}`}>{value}</span>{sub && <span className="sub">{sub}</span>}</div></div>;
}
export function PageHeader({ title, subtitle, actions }) {
  return <div className="page-h"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div><div className="row wrap">{actions}</div></div>;
}
export function Tabs({ tabs, value, onChange }) {
  return <div className="tabs" role="tablist">{tabs.map((t) => { const k = typeof t === 'string' ? t : t.value; return <button key={k} role="tab" className={`tab ${value === k ? 'active' : ''}`} onClick={() => onChange(k)}>{typeof t === 'string' ? t : t.label}</button>; })}</div>;
}
export function Chips({ options, value, onChange }) {
  return <div className="chips">{options.map((o) => { const k = typeof o === 'string' ? o : o.value; return <button type="button" key={k} className={`chip ${value === k ? 'active' : ''}`} onClick={() => onChange(k)}>{typeof o === 'string' ? o : o.label}</button>; })}</div>;
}

// ---------------------------------------------------------------- states
export function Skeleton({ rows = 4, height = 18 }) { return <div className="col">{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" style={{ height, width: `${90 - (i % 3) * 15}%` }} />)}</div>; }
export function Empty({ title = 'Nothing here yet', children, icon: Icon = Inbox }) { return <div className="empty"><Icon size={40} /><div className="bold">{title}</div>{children}</div>; }
export function ErrorState({ error, onRetry }) {
  return <div className="empty"><AlertTriangle size={40} color="var(--danger)" /><div className="bold">{error?.code === 'FORBIDDEN' ? 'No permission' : 'Could not load'}</div><div className="muted small">{error?.message}</div>{onRetry && <Button icon={RefreshCw} onClick={() => onRetry()}>Retry</Button>}</div>;
}
/** Render loading / error / empty / content for a useLoad() result. */
export function Async({ state, children, empty, isEmpty, rows }) {
  if (state.loading && !state.data) return <Skeleton rows={rows || 5} />;
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.reload} />;
  if (!state.data) return null;
  if (isEmpty?.(state.data)) return empty || <Empty />;
  return children(state.data);
}

// ---------------------------------------------------------------- modal
export function Modal({ open, title, onClose, children, footer, size }) {
  useEffect(() => {
    if (!open) return undefined;
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-bg no-print" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${size || ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-h"><h3>{title}</h3>{onClose && <button className="btn ghost icon" onClick={onClose} aria-label="Close"><X size={18} /></button>}</div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}

const ConfirmCtx = createContext(null);
/** Promise-based confirmation & prompt dialogs: await confirm({title, message, reason:true}) */
export function ConfirmProvider({ children }) {
  const [st, set] = useState(null);
  const [reason, setReason] = useState('');
  const ask = useCallback((opts) => new Promise((resolve) => { setReason(''); set({ ...opts, resolve }); }), []);
  const close = (v) => { st?.resolve(v); set(null); };
  const needReason = st?.reason;
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <Modal open={!!st} title={st?.title || 'Confirm'} onClose={() => close(false)}
        footer={<><Button onClick={() => close(false)}>Cancel</Button>
          <Button variant={st?.danger ? 'danger' : 'primary'} disabled={needReason && reason.trim().length < 3} onClick={() => close(needReason ? reason.trim() : true)}>{st?.confirmText || 'Confirm'}</Button></>}>
        <div className="col">
          {st?.message && <div style={{ whiteSpace: 'pre-line' }}>{st.message}</div>}
          {st?.details && <div className="card flat tight">{st.details}</div>}
          {needReason && <Textarea label={typeof needReason === 'string' ? needReason : 'Reason (required)'} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />}
        </div>
      </Modal>
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmCtx);

// ---------------------------------------------------------------- table + pagination
export function Table({ columns, rows, onRowClick, rowKey = 'id', empty }) {
  if (!rows?.length) return empty || <Empty />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>{columns.map((c) => <th key={c.key || c.label} className={c.num ? 'num' : ''} style={{ width: c.width }}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r[rowKey] ?? i} className={onRowClick ? 'clickable' : ''} onClick={onRowClick ? () => onRowClick(r) : undefined}>
              {columns.map((c) => <td key={c.key || c.label} className={c.num ? 'num' : ''}>{c.render ? c.render(r) : r[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function Pager({ page, pages, total, onPage }) {
  if (!total) return null;
  return (
    <div className="pager"><span>{total.toLocaleString()} records</span>
      <div className="row"><Button size="sm" icon={ChevronLeft} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous" /><span>Page {page} / {pages}</span>
        <Button size="sm" icon={ChevronRight} disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next" /></div></div>
  );
}

/** Server-paginated list with filters. fetcher(params) must return {items,total,page,pages}. */
export function usePaged(path, filters = {}, deps = [], enabled = true) {
  const [page, setPage] = useState(1);
  const key = JSON.stringify(filters);
  useEffect(() => setPage(1), [key]);
  const state = useLoad(() => (enabled ? api.get(`${path}${toQs({ ...filters, page })}`) : Promise.resolve(null)), [path, key, page, enabled, ...deps]);
  return { ...state, page, setPage };
}
function toQs(o) { const s = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== '' && v != null) s.set(k, v); const q = s.toString(); return q ? `?${q}` : ''; }

export function PagedTable({ state, columns, onRowClick, empty }) {
  return (
    <div className="card pad-0">
      <Async state={state} isEmpty={(d) => !d.items.length} empty={empty || <Empty />}>
        {(d) => <><Table columns={columns} rows={d.items} onRowClick={onRowClick} /><Pager page={d.page} pages={d.pages} total={d.total} onPage={state.setPage} /></>}
      </Async>
    </div>
  );
}

export function Spinner() { return <span className="spinner" />; }
export function Kv({ items }) { return <div className="kv">{items.filter(Boolean).map(([k, v], i) => <Fragment key={i}><div>{k}</div><div>{v ?? '—'}</div></Fragment>)}</div>; }
