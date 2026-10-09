import { useState } from 'react';
import { Package, Boxes } from 'lucide-react';
import { api } from '../../lib/api.js';
import { money, dt } from '../../lib/format.js';
import { EntityPage } from '../../components/entity.jsx';
import { Button, Badge, StatusBadge, Tabs, useLoad, Modal, Select, Input, useAction, PagedTable, usePaged } from '../../components/ui.jsx';
import { mediaSrc } from '../../components/domain.jsx';
import { useAuth } from '../../lib/auth.jsx';

function StockModal({ product, onClose }) {
  const [type, setType] = useState('IN');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [run, busy] = useAction();
  if (!product) return null;
  return (
    <Modal open title={`Stock — ${product.name} (now ${product.stock})`} onClose={() => onClose(false)} footer={<Button variant="primary" loading={busy} disabled={qty === ''} onClick={() => run(() => api.post('/stock/move', { kind: 'PRODUCT', id: product.id, type, qty: Number(qty), reason }), { success: 'Stock updated' }).then(() => onClose(true))}>Save</Button>}>
      <div className="col"><Select label="Movement" value={type} onChange={(e) => setType(e.target.value)} options={[{ value: 'IN', label: 'Stock in' }, { value: 'OUT', label: 'Stock out' }, { value: 'ADJUST', label: 'Adjust to count' }]} /><Input label="Quantity" type="number" value={qty} onChange={(e) => setQty(e.target.value)} /><Input label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
    </Modal>
  );
}

export default function Products() {
  const { can, settings } = useAuth();
  const [tab, setTab] = useState('products');
  const [stock, setStock] = useState(null);
  const [k, setK] = useState(0);
  const merchants = useLoad(() => api.get('/merchants').catch(() => ({ items: [] })), [tab]);
  const branches = useLoad(() => api.get('/branches'), []);
  const moves = usePaged('/stock/movements', { kind: 'PRODUCT' }, [], tab === 'stock');
  const mopts = (merchants.data?.items || []).map((m) => ({ value: m.id, label: m.name }));
  return (
    <div>
      <Tabs tabs={[{ value: 'products', label: 'Products' }, ...(settings?.general?.modules?.food || can('merchant.manage') ? [{ value: 'merchants', label: 'Food Park merchants' }] : []), ...(can('stock.manage') ? [{ value: 'stock', label: 'Stock movements' }] : [])]} value={tab} onChange={setTab} />
      {tab === 'products' && <EntityPage key={k} title="Products" subtitle="Food, drinks and merchandise sold at the POS (payable by card balance)" path="/products" query={{ all: '1' }} managePerm="product.manage" singular="product" deleteLabel="Deactivate"
        filters={[{ name: 'merchantId', label: 'Merchant', options: mopts }, { name: 'status', label: 'Status', options: ['ACTIVE', 'INACTIVE'] }]}
        extraActions={(r) => r.track_stock && can('stock.manage') && <Button size="sm" icon={Boxes} onClick={() => setStock(r)}>Stock</Button>}
        columns={[{ label: '', render: (r) => r.image_media_id ? <img src={mediaSrc(r.image_media_id)} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 8 }} /> : <Package /> },
          { label: 'Product', render: (r) => <><b>{r.name}</b><div className="xs muted">{r.sku} {r.barcode && `· ${r.barcode}`} · {r.category}</div></> }, { key: 'kind', label: 'Kind' }, { key: 'merchant_name', label: 'Merchant' },
          { label: 'Price', num: true, render: (r) => money(r.price) }, { label: 'Stock', num: true, render: (r) => (r.track_stock ? <span className={r.stock <= r.low_stock_threshold ? 'danger bold' : ''}>{r.stock}</span> : '∞') },
          { label: 'VAT', render: (r) => (r.taxable ? 'Yes' : 'No') }, { label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]}
        fields={(row) => [{ name: 'name', label: 'Name', required: true }, { name: 'sku', label: 'SKU' }, { name: 'barcode', label: 'Barcode' }, { name: 'category', label: 'Category' },
          { name: 'kind', label: 'Kind', type: 'select', options: ['FOOD', 'MERCHANDISE', 'SERVICE'].map((v) => ({ value: v, label: v })) }, { name: 'merchantId', label: 'Merchant (Food Park)', type: 'select', options: mopts },
          { name: 'branchId', label: 'Branch', type: 'select', options: (branches.data?.items || []).map((b) => ({ value: b.id, label: b.name })) }, { name: 'price', label: 'Price ฿', type: 'money', required: true, min: 0 }, { name: 'cost', label: 'Cost ฿', type: 'money', min: 0 },
          { name: 'imageMediaId', label: 'Image', type: 'media', category: 'PRODUCT' }, { name: 'trackStock', label: 'Track stock', type: 'switch' }, ...(row?.id ? [] : [{ name: 'stock', label: 'Initial stock', type: 'number', min: 0, show: (f) => f.trackStock }]),
          { name: 'lowStockThreshold', label: 'Low stock alert at', type: 'number', min: 0, show: (f) => f.trackStock }, { name: 'taxable', label: 'Subject to VAT', type: 'switch' }, { name: 'sort', label: 'Sort', type: 'number' },
          { name: 'status', label: 'Status', type: 'select', options: ['ACTIVE', 'INACTIVE'].map((v) => ({ value: v, label: v })) }]}
        defaults={{ kind: 'FOOD', category: 'GENERAL', trackStock: false, taxable: true, status: 'ACTIVE', sort: 0, lowStockThreshold: 0 }}
        toForm={(r) => ({ name: r.name, sku: r.sku, barcode: r.barcode, category: r.category, kind: r.kind, merchantId: r.merchant_id, branchId: r.branch_id, price: r.price, cost: r.cost, imageMediaId: r.image_media_id, trackStock: r.track_stock, lowStockThreshold: r.low_stock_threshold, taxable: r.taxable, sort: r.sort, status: r.status })}
        toPayload={(f) => ({ ...f, price: Number(f.price), cost: f.cost === '' || f.cost == null ? null : Number(f.cost), stock: f.stock ? Number(f.stock) : undefined, lowStockThreshold: Number(f.lowStockThreshold || 0), sort: Number(f.sort || 0), merchantId: f.merchantId || null, branchId: f.branchId || null, imageMediaId: f.imageMediaId || null, trackStock: !!f.trackStock, taxable: f.taxable !== false })} />}
      {tab === 'merchants' && <EntityPage title="Food Park merchants" subtitle="Each merchant has its own products, POS (assign staff to merchant), revenue & settlement (Reports → Merchant)" path="/merchants" paged={false} managePerm="merchant.manage" singular="merchant" deletable={false}
        columns={[{ label: 'Code', render: (r) => <code>{r.merchant_code}</code> }, { label: '', render: (r) => r.logo_media_id && <img src={mediaSrc(r.logo_media_id)} alt="" style={{ height: 32 }} /> }, { key: 'name', label: 'Merchant' }, { key: 'branch_name', label: 'Branch' }, { label: 'Commission', num: true, render: (r) => `${r.commission_pct}%` }, { label: 'Status', render: (r) => <StatusBadge status={r.status} /> }]}
        fields={[{ name: 'merchantCode', label: 'Merchant ID', required: true, upper: true }, { name: 'name', label: 'Name', required: true }, { name: 'logoMediaId', label: 'Logo', type: 'media', category: 'LOGO' },
          { name: 'branchId', label: 'Branch', type: 'select', options: (branches.data?.items || []).map((b) => ({ value: b.id, label: b.name })) }, { name: 'commissionPct', label: 'Commission %', type: 'number', min: 0 }, { name: 'status', label: 'Status', type: 'select', options: ['ACTIVE', 'INACTIVE'].map((v) => ({ value: v, label: v })) }]}
        defaults={{ commissionPct: 0, status: 'ACTIVE' }}
        toForm={(r) => ({ merchantCode: r.merchant_code, name: r.name, logoMediaId: r.logo_media_id, branchId: r.branch_id, commissionPct: r.commission_pct, status: r.status })}
        toPayload={(f) => ({ ...f, commissionPct: Number(f.commissionPct || 0), branchId: f.branchId || null, logoMediaId: f.logoMediaId || null })} />}
      {tab === 'stock' && <PagedTable state={moves} columns={[{ key: 'item_name', label: 'Item' }, { key: 'type', label: 'Type', render: (r) => <Badge>{r.type}</Badge> }, { label: 'Qty', num: true, render: (r) => (r.qty > 0 ? `+${r.qty}` : r.qty) }, { label: 'Stock', render: (r) => `${r.stock_before} → ${r.stock_after}` }, { label: 'Ref / reason', render: (r) => r.reference || r.reason }, { key: 'staff_name', label: 'Staff' }, { label: 'Date', render: (r) => dt(r.created_at) }]} />}
      <StockModal product={stock} onClose={(ok) => { setStock(null); if (ok) setK((x) => x + 1); }} />
    </div>
  );
}
