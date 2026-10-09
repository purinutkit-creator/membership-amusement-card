// Generic, config-driven CRUD page: list (search / filter / paginate) + validated form modal.
import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Search } from 'lucide-react';
import { api, qs } from '../lib/api.js';
import { Button, Input, Select, Textarea, Switch, Field, Modal, PageHeader, PagedTable, usePaged, useAction, useConfirm, useLoad, useDebounced, Async, Table, Empty } from './ui.jsx';
import { MediaField } from './domain.jsx';
import { useAuth } from '../lib/auth.jsx';

export function FormField({ f, value, onChange, form }) {
  const set = (v) => onChange(f.name, v);
  if (f.show && !f.show(form)) return null;
  const common = { label: f.label + (f.required ? ' *' : ''), hint: f.hint };
  switch (f.type) {
    case 'select': return <Select {...common} value={value ?? ''} options={typeof f.options === 'function' ? f.options(form) : f.options} placeholder={f.placeholder ?? (f.required ? undefined : '—')} onChange={(e) => set(e.target.value)} />;
    case 'switch': return <div className="field"><Switch label={f.label} hint={f.hint} checked={!!value} onChange={set} /></div>;
    case 'textarea': return <Textarea {...common} value={value ?? ''} onChange={(e) => set(e.target.value)} />;
    case 'media': return <MediaField label={f.label} value={value} kind={f.kind || 'IMAGE'} category={f.category} onChange={set} />;
    case 'multiselect': {
      const opts = typeof f.options === 'function' ? f.options(form) : f.options;
      const arr = value || [];
      return <Field {...common}><div className="chips">{opts.map((o) => <button type="button" key={o.value} className={`chip ${arr.includes(o.value) ? 'active' : ''}`} onClick={() => set(arr.includes(o.value) ? arr.filter((x) => x !== o.value) : [...arr, o.value])}>{o.label}</button>)}{!opts.length && <span className="faint small">No options</span>}</div></Field>;
    }
    case 'days': {
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const arr = value || [];
      return <Field {...common}><div className="chips">{names.map((n, i) => <button type="button" key={n} className={`chip ${arr.includes(i) ? 'active' : ''}`} onClick={() => set(arr.includes(i) ? arr.filter((x) => x !== i) : [...arr, i].sort())}>{n}</button>)}</div></Field>;
    }
    case 'color': return <Field {...common}><div className="row"><input type="color" value={value || '#000000'} onChange={(e) => set(e.target.value)} style={{ width: 52, height: 42, border: 0, background: 'none' }} /><input className="input" value={value || ''} onChange={(e) => set(e.target.value)} /></div></Field>;
    case 'number': case 'money': return <Input {...common} type="number" inputMode="decimal" step={f.type === 'money' ? '0.01' : f.step || '1'} min={f.min} value={value ?? ''} onChange={(e) => set(e.target.value === '' ? '' : Number(e.target.value))} />;
    case 'datetime': return <Input {...common} type="datetime-local" value={value ? String(value).slice(0, 16) : ''} onChange={(e) => set(e.target.value)} />;
    case 'date': return <Input {...common} type="date" value={value ? String(value).slice(0, 10) : ''} onChange={(e) => set(e.target.value)} />;
    case 'time': return <Input {...common} type="time" value={value || ''} onChange={(e) => set(e.target.value)} />;
    case 'password': return <Input {...common} type="password" autoComplete="new-password" value={value ?? ''} onChange={(e) => set(e.target.value)} />;
    case 'custom': return f.render({ value, set, form, onChange });
    default: return <Input {...common} value={value ?? ''} maxLength={f.maxLength} onChange={(e) => set(f.upper ? e.target.value.toUpperCase() : e.target.value)} />;
  }
}

export function FormFields({ fields, form, setForm, cols = 2 }) {
  const onChange = (k, v) => setForm((s) => ({ ...s, [k]: v }));
  return <div className={`grid g${cols}`}>{fields.map((f) => <div key={f.name} style={f.full ? { gridColumn: '1 / -1' } : undefined}><FormField f={f} value={form[f.name]} onChange={onChange} form={form} /></div>)}</div>;
}

export function validate(fields, form) {
  for (const f of fields) {
    if (f.show && !f.show(form)) continue;
    const v = form[f.name];
    if (f.required && (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length))) return `${f.label} is required`;
    if (f.pattern && v && !f.pattern.test(String(v))) return f.patternMessage || `${f.label} is invalid`;
    if ((f.type === 'number' || f.type === 'money') && v !== '' && v != null && f.min != null && v < f.min) return `${f.label} must be ≥ ${f.min}`;
  }
  return null;
}

/** Modal form used by EntityPage and stand-alone pages. */
export function EntityForm({ open, title, fields, initial, onClose, onSubmit, size }) {
  const [form, setForm] = useState(initial || {});
  const [error, setError] = useState(null);
  const [run, busy] = useAction();
  const key = JSON.stringify(initial);
  useEffect(() => { setForm(initial || {}); setError(null); }, [key, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async () => {
    const err = validate(fields, form);
    if (err) { setError(err); return; }
    setError(null);
    await run(() => onSubmit(form), { success: 'Saved' }).then(() => onClose(true)).catch((e) => setError(e.message));
  };
  return (
    <Modal open={open} title={title} onClose={() => onClose(false)} size={size || 'wide'}
      footer={<><Button onClick={() => onClose(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Save</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {error && <div className="alert danger mb">{error}</div>}
        <FormFields fields={fields} form={form} setForm={setForm} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/**
 * cfg: { title, subtitle, path, columns, fields, managePerm, toForm, toPayload, defaults,
 *        filters:[{name,label,options}], paged (default true), extraActions(row,reload), headerActions(reload), onRowClick, deletable, deleteLabel }
 */
export function EntityPage(cfg) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [filters, setFilters] = useState({});
  const [editing, setEditing] = useState(null);
  const [run] = useAction();
  const manage = !cfg.managePerm || can(cfg.managePerm);
  const paged = cfg.paged !== false;
  const pagedState = usePaged(cfg.path, { q: dq, ...filters, ...(cfg.query || {}) }, [], paged);
  const listState = useLoad(() => (paged ? Promise.resolve(null) : api.get(`${cfg.path}${qs(cfg.query)}`)), [cfg.path, JSON.stringify(cfg.query)]);
  const state = paged ? pagedState : listState;
  const reload = () => state.reload(true);

  const cols = [...cfg.columns];
  if (manage || cfg.extraActions) {
    cols.push({ key: '_a', label: '', render: (r) => (
      <div className="row" style={{ justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
        {cfg.extraActions?.(r, reload)}
        {manage && cfg.fields && <Button size="sm" icon={Pencil} onClick={() => setEditing(r)} aria-label="Edit" />}
        {manage && cfg.deletable !== false && cfg.fields && <Button size="sm" variant="ghost" icon={Trash2} aria-label="Delete" onClick={async () => {
          if (await confirm({ title: cfg.deleteLabel || 'Delete', message: `Delete / deactivate "${r.name || r.code || r.id}"?`, danger: true })) await run(() => api.del(`${cfg.path}/${r.id}`), { success: 'Done' }).then(reload);
        }} />}
      </div>
    ) });
  }
  return (
    <div>
      <PageHeader title={cfg.title} subtitle={cfg.subtitle} actions={<>{cfg.headerActions?.(reload)}{manage && cfg.fields && <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>Add</Button>}</>} />
      {(paged || cfg.filters) && (
        <div className="toolbar">
          {paged && cfg.search !== false && <div className="search-box"><Search size={18} /><input className="input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} /></div>}
          {cfg.filters?.map((f) => <select key={f.name} className="input" value={filters[f.name] || ''} onChange={(e) => setFilters((s) => ({ ...s, [f.name]: e.target.value }))}><option value="">{f.label}: All</option>{f.options.map((o) => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}</select>)}
        </div>
      )}
      {paged ? <PagedTable state={pagedState} columns={cols} onRowClick={cfg.onRowClick} />
        : <div className="card pad-0"><Async state={listState} isEmpty={(d) => !(d.items || d).length} empty={<Empty />}>{(d) => <Table columns={cols} rows={d.items || d} onRowClick={cfg.onRowClick} />}</Async></div>}
      {cfg.fields && <EntityForm open={!!editing} title={editing?.id ? `Edit ${cfg.singular || ''}` : `New ${cfg.singular || ''}`} fields={typeof cfg.fields === 'function' ? cfg.fields(editing) : cfg.fields}
        initial={editing?.id ? cfg.toForm?.(editing) ?? editing : { ...(cfg.defaults || {}) }}
        onClose={(saved) => { setEditing(null); if (saved) reload(); }}
        onSubmit={(form) => { const body = cfg.toPayload ? cfg.toPayload(form) : form; return editing?.id ? api.put(`${cfg.path}/${editing.id}`, body) : api.post(cfg.path, body); }} />}
    </div>
  );
}
