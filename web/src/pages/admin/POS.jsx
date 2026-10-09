import { useCallback, useEffect, useMemo, useState } from 'react';
import { Wallet, Package, CreditCard, Trash2, ShoppingCart, Plus, Minus, Percent, Gift, RefreshCcw, Check, AlertTriangle, Repeat } from 'lucide-react';
import { api } from '../../lib/api.js';
import { money, maskCard } from '../../lib/format.js';
import { useKeyboardWedge, useCardReads } from '../../lib/readers.js';
import { usePairing } from '../../lib/pairing.js';
import { Button, Badge, Tabs, Chips, Input, Modal, useLoad, useToast, useDebounced, Empty, useAction, Select } from '../../components/ui.jsx';
import { CardScanInput, CardChip, mediaSrc } from '../../components/domain.jsx';
import { useAuth } from '../../lib/auth.jsx';
import PaymentModal from './pos/PaymentModal.jsx';
import { RegisterMemberModal, MemberLookup, MemberChip, DisplayControl, ShiftBar } from './pos/parts.jsx';
import { play } from '../../lib/sound.js';

const uid = () => Math.random().toString(36).slice(2);

export default function POS({ mode = 'full' }) {
  const { can, settings } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState(mode === 'topup' ? 'topup' : can('topup.create') ? 'topup' : 'products');
  const [member, setMember] = useState(null);
  const [card, setCard] = useState(null);
  const [cart, setCart] = useState([]);
  const [discount, setDiscount] = useState(null);
  const [priced, setPriced] = useState(null);
  const [priceErr, setPriceErr] = useState(null);
  const [order, setOrder] = useState(null);
  const [register, setRegister] = useState(null);
  const [custom, setCustom] = useState('');
  const [cat, setCat] = useState('');
  const [merchant, setMerchant] = useState('');
  const [discountOpen, setDiscountOpen] = useState(false);
  const [newCardOpen, setNewCardOpen] = useState(null);
  const [run, busy] = useAction();

  const shift = useLoad(() => api.get('/shifts/current'), []);
  const packages = useLoad(() => api.get('/packages'), []);
  const products = useLoad(() => (mode === 'full' && can('pos.open') ? api.get(`/products?pageSize=200${merchant ? `&merchantId=${merchant}` : ''}`) : Promise.resolve({ items: [] })), [merchant]);
  const merchants = useLoad(() => (settings?.general?.modules?.food ? api.get('/merchants').catch(() => ({ items: [] })) : Promise.resolve({ items: [] })), []);
  const displaySettings = settings?.display || {};

  // ---------------------------------------------------------------- customer display sync
  const pairing = usePairing(async (e) => {
    if (e.type === 'PHONE') {
      if (!e.found) { toast.warning(`Member not found for ${e.value}`); pairing.push({ ...displayState, screen: 'MEMBER_NOT_FOUND' }); return; }
      const m = await api.get(`/members/${e.memberId}`);
      selectMember(m); toast.info(`Customer entered phone: ${m.firstName}`);
    } else if (e.type === 'CARD') {
      if (!e.cardId) { toast.error('CARD NOT FOUND'); return; }
      selectCard(await api.get(`/cards/${e.cardId}`));
    } else if (e.type === 'IS_MEMBER') {
      if (e.value) pairing.push({ ...displayState, screen: 'PHONE_INPUT' }); else pairing.push({ ...displayState, screen: 'ORDER' });
    } else if (e.type === 'LANGUAGE') toast.info(`Customer chose ${String(e.value).toUpperCase()}`);
    else if (e.type === 'CONSENT') toast.success('Customer accepted privacy policy');
  });

  const lines = priced?.lines || [];
  const totals = priced?.totals;
  const displayState = useMemo(() => ({
    screen: cart.length ? 'ORDER' : member || card ? 'CUSTOMER' : 'IDLE',
    member: member ? { name: member.firstName, tier: member.tier?.name || null } : null,
    card: card ? { number: maskCard(card.cardNumber), balance: card.balance, points: card.points, stamps: card.stamps } : null,
    lines: lines.map((l) => ({ name: l.name, qty: l.qty, total: l.total, bonus: l.meta?.bonus || 0, newBalance: l.meta?.newBalance })),
    totals: totals && { subtotal: totals.subtotal, discount: totals.manualDiscount + totals.promoDiscount + totals.tierDiscount + totals.lineDiscounts, vat: totals.vat, service: totals.service, grandTotal: totals.grandTotal },
    promotions: priced?.promotions?.map((p) => p.name) || [],
  }), [cart.length, member, card, lines, totals, priced]);
  useEffect(() => { if (!order) pairing.push(displayState); }, [displayState, order]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- identification
  const selectMember = (m) => {
    setMember(m);
    setPriceErr(null);
    if (card && card.member && card.member.id !== m.id) { setCard(null); toast.warning('Previous card does not belong to this member — scan the member card'); }
    pairing.push({ ...displayState, screen: 'TAP_CARD', member: { name: m.firstName, tier: m.tier?.name } });
  };
  const selectCard = async (c) => {
    if (c.status === 'INACTIVE') { setNewCardOpen(c); return; }
    if (member && c.member?.id !== member.id) {
      play('error');
      toast.error('CARD DOES NOT BELONG TO MEMBER');
      pairing.push({ ...displayState, screen: 'ERROR', error: 'CARD_MEMBER_MISMATCH' });
      return;
    }
    if (c.status !== 'ACTIVE') { toast.error(`CARD ${c.status}`); play('error'); }
    setCard(c);
    if (!member && c.member) setMember(await api.get(`/members/${c.member.id}`));
  };
  const lookupCard = async (ident) => {
    try { selectCard(await api.get(`/cards/lookup?identifier=${encodeURIComponent(ident)}`)); play('tap'); } catch (e) { toast.error(e.message); play('error'); }
  };
  const onScan = (v) => {
    const p = products.data?.items.find((x) => x.barcode === v || x.sku === v);
    if (p) { addProduct(p); return; }
    lookupCard(v);
  };
  useKeyboardWedge(onScan, { enabled: !order && !register });
  useCardReads(onScan, !order && !register);

  // ---------------------------------------------------------------- cart
  const addProduct = (p) => setCart((c) => {
    const ex = c.find((i) => i.type === 'PRODUCT' && i.productId === p.id);
    if (ex) return c.map((i) => (i === ex ? { ...i, qty: i.qty + 1 } : i));
    return [...c, { uid: uid(), type: 'PRODUCT', productId: p.id, qty: 1, label: p.name }];
  });
  const addTopup = (pkg, amount) => {
    if (!card) { toast.warning('Tap / scan the destination card first'); return; }
    setCart((c) => [...c.filter((i) => !(i.type === 'TOPUP' && i.cardId === card.id)), { uid: uid(), type: 'TOPUP', cardId: card.id, packageId: pkg?.id, amount: pkg ? undefined : amount, label: pkg ? pkg.name : `฿${amount}` }]);
    setCustom('');
  };
  const issueCard = (c, asMember) => {
    const m = asMember ? member : null;
    setCart((x) => [...x.filter((i) => !(i.type === 'CARD_ISSUE' && i.cardId === c.id)), { uid: uid(), type: 'CARD_ISSUE', cardId: c.id, memberId: m?.id || null, label: `Issue ${m ? 'member' : 'guest'} card ${c.cardNumber}` }]);
    setCard({ ...c, status: 'ACTIVE', member: m ? { id: m.id, name: `${m.firstName} ${m.lastName}`, memberCode: m.memberCode } : null, cardType: m ? 'MEMBER' : 'GUEST', pendingIssue: true });
    setNewCardOpen(null);
  };
  const qty = (u, d) => setCart((c) => c.map((i) => (i.uid === u ? { ...i, qty: Math.max(1, i.qty + d) } : i)));
  const remove = (u) => setCart((c) => c.filter((i) => i.uid !== u));
  const reset = () => { setCart([]); setMember(null); setCard(null); setDiscount(null); setPriced(null); setOrder(null); setPriceErr(null); pairing.push({ screen: 'IDLE' }); shift.reload(true); };

  const payload = useMemo(() => ({
    memberId: member?.id || null, cardId: card && !card.pendingIssue ? card.id : null, merchantId: merchant || null,
    items: cart.map(({ uid: _u, label: _l, ...i }) => i), manualDiscount: discount || undefined,
  }), [cart, member, card, discount, merchant]);
  const dPayload = useDebounced(JSON.stringify(payload), 250);
  useEffect(() => {
    if (!cart.length) { setPriced(null); setPriceErr(null); return; }
    api.post('/orders/price', JSON.parse(dPayload), { approval: false }).then((r) => { setPriced(r); setPriceErr(null); }).catch((e) => { setPriceErr(e.message); setPriced(null); });
  }, [dPayload]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkout = async () => {
    const r = await run(() => api.post('/orders', payload));
    setOrder(r.order);
  };

  const cats = useMemo(() => [...new Set((products.data?.items || []).map((p) => p.category))], [products.data]);
  const tabs = mode === 'topup' ? [] : [
    can('topup.create') && { value: 'topup', label: 'Top Up' },
    { value: 'products', label: 'Food & Products' },
    can('card.issue') && { value: 'cards', label: 'Cards' },
  ].filter(Boolean);

  const step = mode === 'topup' ? (!member && !card ? 0 : !card ? 1 : !cart.length ? 2 : order ? 4 : 3) : -1;

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row between wrap no-print">
        <h1 style={{ margin: 0 }}>{mode === 'topup' ? 'Top Up' : 'POS / Cashier'}</h1>
        <div className="row wrap"><ShiftBar shift={shift.data} loading={shift.loading} reload={() => shift.reload(true)} />{settings?.general?.modules?.customerDisplay !== false && <DisplayControl pairing={pairing} />}</div>
      </div>
      {mode === 'topup' && <div className="steps">{['Identify member', 'Tap / scan card', 'Package / amount', 'Payment', 'Receipt'].map((s, i) => <span key={s} className={`step ${i === step ? 'active' : i < step ? 'done' : ''}`}>{i < step ? <Check size={14} /> : i + 1}. {s}</span>)}</div>}
      <div className="pos">
        <div className="pos-left">
          {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={setTab} />}
          {tab === 'topup' && (
            <div className="col" style={{ overflow: 'auto' }}>
              {!card ? <div className="alert warning"><AlertTriangle size={18} /> Identify the member, then tap / scan the card that will receive the balance.</div>
                : <div className="alert success"><Check size={18} /> Destination card: <b className="mono">{card.cardNumber}</b> — current balance {money(card.balance)}</div>}
              <div className="pos-tiles">
                {(packages.data?.items || []).map((p) => (
                  <button key={p.id} className="tile" disabled={!card} onClick={() => addTopup(p)} style={{ opacity: card ? 1 : 0.55 }}>
                    {p.image_media_id && <img src={mediaSrc(p.image_media_id)} alt="" style={{ height: 40, objectFit: 'contain', alignSelf: 'flex-start' }} />}
                    <b>{p.name}</b>
                    {Number(p.bonus_amount) > 0 && <Badge tone="success">+{money(p.bonus_amount)} bonus</Badge>}
                    {(p.point_bonus > 0 || p.stamp_bonus > 0) && <span className="xs muted">{p.point_bonus > 0 && `+${p.point_bonus} pts `}{p.stamp_bonus > 0 && `+${p.stamp_bonus} stamps`}</span>}
                    {p.member_only && <Badge tone="info">Members</Badge>}
                    <span className="t-price">{money(p.pay_amount)}</span>
                  </button>
                ))}
              </div>
              <form className="row" onSubmit={(e) => { e.preventDefault(); if (Number(custom) > 0) addTopup(null, Number(custom)); }}>
                <Input className="grow" size="lg" type="number" inputMode="decimal" placeholder="Custom amount ฿" value={custom} onChange={(e) => setCustom(e.target.value)} disabled={!card} />
                <Button type="submit" size="lg" icon={Plus} disabled={!card || !(Number(custom) > 0)}>Add top-up</Button>
              </form>
            </div>
          )}
          {tab === 'products' && (
            <>
              <div className="row wrap">
                {merchants.data?.items.length > 0 && <div style={{ width: 200 }}><Select value={merchant} onChange={(e) => setMerchant(e.target.value)} options={[{ value: '', label: 'All merchants' }, ...merchants.data.items.map((m) => ({ value: m.id, label: m.name }))]} /></div>}
                <Chips options={[{ value: '', label: 'All' }, ...cats.map((c) => ({ value: c, label: c }))]} value={cat} onChange={setCat} />
              </div>
              <div className="pos-tiles">
                {(products.data?.items || []).filter((p) => !cat || p.category === cat).map((p) => (
                  <button key={p.id} className="tile" onClick={() => addProduct(p)} disabled={p.track_stock && p.stock <= 0}>
                    {p.image_media_id && <img src={mediaSrc(p.image_media_id)} alt="" style={{ height: 56, objectFit: 'cover', borderRadius: 8 }} />}
                    <b>{p.name}</b><span className="xs muted">{p.merchant_name || p.category}{p.track_stock && ` · stock ${p.stock}`}</span>
                    <span className="t-price">{money(p.price)}</span>
                  </button>
                ))}
                {!products.data?.items.length && <Empty title="No products" />}
              </div>
            </>
          )}
          {tab === 'cards' && <CardsTab member={member} card={card} onIssue={setNewCardOpen} setCart={setCart} toast={toast} />}
        </div>

        <div className="pos-right">
          <div style={{ padding: 14, borderBottom: '1px solid var(--border)' }} className="col gap-s">
            {member ? <MemberChip member={member} onClear={() => { setMember(null); setCard(null); setCart((c) => c.filter((i) => i.type === 'PRODUCT')); }} />
              : <MemberLookup onMember={selectMember} onRegister={(phone) => setRegister({ phone })} paired={pairing.paired} onAskDisplay={() => pairing.push({ ...displayState, screen: displaySettings.memberPrompt === false ? 'PHONE_INPUT' : 'MEMBER_PROMPT' })} />}
            {card ? <CardChip card={card} onClear={() => { setCard(null); setCart((c) => c.filter((i) => i.type === 'PRODUCT')); }} />
              : <CardScanInput onCard={selectCard} size="" wedge={false} placeholder={member ? 'Tap / scan the MEMBER card' : 'Tap / scan card (optional)'} autoFocus={false} />}
            {member && !card && pairing.paired && <Button size="sm" onClick={() => pairing.push({ ...displayState, screen: 'TAP_CARD' })}>Ask customer to tap card on display</Button>}
          </div>
          <div className="cart-lines">
            {cart.length === 0 ? <Empty title="Cart is empty" icon={ShoppingCart} /> : cart.map((i) => {
              const l = lines[cart.indexOf(i)];
              return (
                <div key={i.uid} className="cart-line">
                  <div><div className="bold">{l?.name || i.label}</div>
                    {i.type === 'TOPUP' && l && <div className="xs muted">Card {maskCard(l.meta.cardNumber)} · {money(l.meta.currentBalance)} → <b className="success">{money(l.meta.newBalance)}</b>{l.meta.bonus > 0 && <> · bonus +{money(l.meta.bonus)}</>}</div>}
                    {l?.meta?.promotions?.map((p) => <Badge key={p.id} tone="success"><Gift size={11} />{p.name}</Badge>)}
                    {i.type === 'PRODUCT' && <div className="row mt-s"><div className="qty"><button onClick={() => qty(i.uid, -1)} aria-label="Less"><Minus size={14} /></button><span>{i.qty}</span><button onClick={() => qty(i.uid, 1)} aria-label="More"><Plus size={14} /></button></div></div>}
                  </div>
                  <div className="right"><div className="bold num">{l ? money(l.total) : '…'}</div>{l?.discount > 0 && <div className="xs success">-{money(l.discount)}</div>}
                    <Button variant="ghost" size="sm" icon={Trash2} onClick={() => remove(i.uid)} aria-label="Remove" /></div>
                </div>
              );
            })}
          </div>
          {priceErr && <div className="alert danger" style={{ margin: 10 }}><AlertTriangle size={18} />{priceErr}</div>}
          <div className="cart-sum">
            <div className="r"><span>Subtotal</span><span>{money(totals?.subtotal ?? 0)}</span></div>
            {totals && (totals.lineDiscounts + totals.manualDiscount) > 0 && <div className="r success"><span>Discount</span><span>-{money(totals.lineDiscounts + totals.manualDiscount)}</span></div>}
            {totals?.tierDiscount > 0 && <div className="r success"><span>Tier discount</span><span>-{money(totals.tierDiscount)}</span></div>}
            {totals?.promoDiscount > 0 && <div className="r success"><span>Promotion</span><span>-{money(totals.promoDiscount)}</span></div>}
            {totals?.service > 0 && <div className="r"><span>Service {totals.serviceRate}%</span><span>{money(totals.service)}</span></div>}
            {totals?.vat > 0 && <div className="r"><span>VAT {totals.vatRate}% {totals.vatMode === 'INCLUSIVE' ? '(incl.)' : ''}</span><span>{money(totals.vat)}</span></div>}
            <div className="r total"><span>Total</span><span>{money(totals?.grandTotal ?? 0)}</span></div>
            <div className="row">
              {can('pos.discount') && mode === 'full' && <Button icon={Percent} onClick={() => setDiscountOpen(true)} disabled={!cart.some((i) => i.type === 'PRODUCT')}>Discount</Button>}
              <Button icon={RefreshCcw} onClick={reset}>Clear</Button>
              <Button variant="primary" size="lg" className="grow" loading={busy} disabled={!cart.length || !priced || !shift.data} onClick={checkout}>Charge {totals ? money(totals.grandTotal) : ''}</Button>
            </div>
          </div>
        </div>
      </div>

      {order && <PaymentModal order={order} display={(s) => pairing.push({ ...displayState, ...s })} onClose={(paid) => { if (paid) reset(); else { setOrder(null); api.post(`/orders/${order.id}/void`, { reason: 'Payment cancelled at POS' }, { approval: true }).catch(() => {}); } }} />}
      <RegisterMemberModal open={!!register} initialPhone={register?.phone} onClose={(m) => { setRegister(null); if (m) selectMember(m); }} />
      <Modal open={!!newCardOpen} title="Card not issued yet" onClose={() => setNewCardOpen(null)}>
        {newCardOpen && <div className="col"><div>Card <b className="mono">{newCardOpen.cardNumber}</b> is in stock (INACTIVE). Issue it now? Deposit {money(settings?.card?.deposit || 0)} will be added to the cart.</div>
          {member && <Button variant="primary" size="lg" onClick={() => issueCard(newCardOpen, true)}>Issue as {member.firstName}'s member card</Button>}
          {settings?.card?.guestCardEnabled !== false && <Button size="lg" onClick={() => issueCard(newCardOpen, false)}>Issue as guest card</Button>}</div>}
      </Modal>
      <DiscountModal open={discountOpen} value={discount} onClose={(d) => { setDiscountOpen(false); if (d !== undefined) setDiscount(d); }} />
    </div>
  );
}

function DiscountModal({ open, value, onClose }) {
  const [m, setM] = useState(value?.mode || 'PERCENT');
  const [v, setV] = useState(value?.value || '');
  const { staff } = useAuth();
  return (
    <Modal open={open} title="Order discount (food & products)" onClose={() => onClose(undefined)} footer={<><Button onClick={() => onClose(null)}>Remove discount</Button><Button variant="primary" onClick={() => onClose(Number(v) > 0 ? { mode: m, value: Number(v) } : null)}>Apply</Button></>}>
      <div className="col"><Chips options={[{ value: 'PERCENT', label: 'Percent %' }, { value: 'AMOUNT', label: 'Amount ฿' }]} value={m} onChange={setM} />
        <Input size="xl" type="number" value={v} onChange={(e) => setV(e.target.value)} autoFocus />
        <div className="small muted">Your limit: {staff?.maxDiscount}% — above it a manager must approve.</div></div>
    </Modal>
  );
}

function CardsTab({ member, card, onIssue, setCart, toast }) {
  const { can } = useAuth();
  const avail = useLoad(() => api.get('/cards/available?limit=12'), []);
  const [newCard, setNewCard] = useState(null);
  return (
    <div className="col" style={{ overflow: 'auto' }}>
      <div className="card"><h3>Issue new card</h3><p className="small muted">Scan a blank card from stock, or pick one below. {member ? `It will be linked to ${member.firstName}.` : 'Without a member it becomes a guest card.'}</p>
        <div className="auto-grid">{(avail.data?.items || []).map((c) => <button key={c.id} className="tile" onClick={() => onIssue({ id: c.id, cardNumber: c.card_number, status: 'INACTIVE', balance: 0, points: 0, stamps: 0 })}><CreditCard /><span className="mono">{c.card_number}</span><span className="xs muted">{c.card_type}</span></button>)}</div>
      </div>
      {can('card.replace') && card && !card.pendingIssue && (
        <div className="card"><h3><Repeat size={18} /> Replace current card</h3>
          <p className="small muted">Transfers balance {money(card.balance)}, {card.points} points and {card.stamps} stamps to a new card. The old card becomes REPLACED immediately. A replacement fee (if set) is charged in this cart.</p>
          {newCard ? <div className="col"><div>New card: <b className="mono">{newCard.cardNumber}</b></div>
            <Button variant="primary" onClick={() => { setCart((c) => [...c, { uid: uid(), type: 'CARD_REPLACEMENT', oldCardId: card.id, newCardId: newCard.id, reason: 'Card replacement at POS', label: `Replace ${maskCard(card.cardNumber)} → ${newCard.cardNumber}` }]); toast.info('Replacement added to cart'); setNewCard(null); }}>Add replacement to cart</Button></div>
            : <CardScanInput wedge={false} autoFocus={false} size="" placeholder="Scan the NEW blank card" onCard={(c) => (c.status === 'INACTIVE' ? setNewCard(c) : toast.error('New card must be an unused (INACTIVE) card'))} />}
        </div>
      )}
    </div>
  );
}
