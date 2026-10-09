import { useEffect, useState } from 'react';
import { Nfc, Plug, Unplug, Radio } from 'lucide-react';
import { ReaderManager, useKeyboardWedge } from '../../lib/readers.js';
import { Button, Card, Badge, Switch, useToast } from '../../components/ui.jsx';
import { dt } from '../../lib/format.js';

/** Settings > Devices > Card Reader: search / connect / disconnect / test read / last read / status / auto-reconnect. */
export default function ReaderPanel() {
  const [st, setSt] = useState(ReaderManager.status());
  const [reads, setReads] = useState([]);
  const [auto, setAuto] = useState(ReaderManager.autoReconnect);
  const [testing, setTesting] = useState(false);
  const toast = useToast();
  useEffect(() => { ReaderManager.restore(); const a = ReaderManager.onStatus(setSt); const b = ReaderManager.onRead((v, s) => { setReads((r) => [{ v, s, at: new Date() }, ...r].slice(0, 8)); setSt(ReaderManager.status()); }); return () => { a(); b(); }; }, []);
  useKeyboardWedge(() => {}, { enabled: testing, whenFocused: true });
  const connect = async (type) => { try { await ReaderManager.connect(type); toast.success(`${type} reader connected`); } catch (e) { toast.error(e.message); } };
  return (
    <Card title="Card reader (this device)" actions={<Badge tone={st.status === 'CONNECTED' ? 'success' : st.status === 'ERROR' ? 'danger' : ''}>{st.status}</Badge>}>
      <div className="small muted mb">Active: <b>{st.label}</b>. Keyboard-emulation readers (most USB RFID / barcode readers) work immediately with no setup.</div>
      <div className="row wrap">
        {Object.values(ReaderManager.readers).map((r) => <Button key={r.type} size="sm" icon={r.type === 'WEB_NFC' ? Nfc : Plug} disabled={!r.supported()} variant={st.type === r.type ? 'primary' : ''} onClick={() => connect(r.type)} title={r.supported() ? '' : 'Not supported by this browser'}>{r.label}</Button>)}
        {st.type !== 'KEYBOARD' && <Button size="sm" variant="danger" icon={Unplug} onClick={() => ReaderManager.disconnect()}>Disconnect</Button>}
      </div>
      <div className="row mt"><Switch label="Auto reconnect" checked={auto} onChange={(v) => { setAuto(v); ReaderManager.autoReconnect = v; localStorage.setItem('sc.reader.auto', v ? '1' : '0'); }} /></div>
      <div className="row mt"><Button icon={Radio} variant={testing ? 'success' : ''} onClick={() => setTesting(!testing)}>{testing ? 'Listening… tap a card' : 'Test read'}</Button>
        <span className="small">Last card read: {st.lastRead ? <><code>{st.lastRead.value}</code> via {st.lastRead.source} · {dt(st.lastRead.at)}</> : '—'}</span></div>
      {reads.length > 0 && <div className="mt-s">{reads.map((r, i) => <div key={i} className="xs mono">{r.at.toLocaleTimeString()} · {r.s} · {r.v}</div>)}</div>}
    </Card>
  );
}
