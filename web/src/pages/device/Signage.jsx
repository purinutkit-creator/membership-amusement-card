import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Maximize, Tv } from 'lucide-react';
import { api } from '../../lib/api.js';
import { applyFont, applyTheme } from '../../lib/theme.js';
import SignagePlayer from '../../components/SignagePlayer.jsx';
import { Button, useLoad } from '../../components/ui.jsx';
import { LANGS } from '../../lib/i18n.jsx';

/** TV / monitor / digital signage: full-screen promotion playlist. */
export default function Signage() {
  const [sp, setSp] = useSearchParams();
  const id = sp.get('playlist') || localStorage.getItem('sc.signage.playlist');
  const lang = sp.get('lang') || 'th';
  const list = useLoad(() => api.get('/public/playlists'), []);
  const [lc, setLc] = useState(0);
  useEffect(() => { api.get('/public/settings').then((s) => { applyTheme(s.theme); applyFont('signage', s.fonts); }).catch(() => {}); }, []);
  // rotate language for text slides every few cycles when lang=auto
  useEffect(() => { if (sp.get('lang') !== 'auto') return undefined; const t = setInterval(() => setLc((x) => (x + 1) % 3), 30000); return () => clearInterval(t); }, [sp]);
  if (!id) {
    return (
      <div className="fs"><div className="fs-center"><Tv size={64} color="var(--primary)" /><h1>Promotion Display</h1><p className="muted">Choose a playlist to play on this screen</p>
        <div className="col" style={{ width: 'min(420px, 100%)' }}>{(list.data?.items || []).map((p) => <Button key={p.id} size="lg" onClick={() => { localStorage.setItem('sc.signage.playlist', p.id); setSp({ playlist: p.id }); }}>{p.name} <span className="xs muted">{p.target}</span></Button>)}</div></div></div>
    );
  }
  return (
    <div className="fs" style={{ background: '#000' }} onDoubleClick={() => document.documentElement.requestFullscreen?.()}>
      <SignagePlayer playlistId={id} lang={sp.get('lang') === 'auto' ? LANGS[lc].code : lang} fallback={<div className="fs-center" style={{ color: '#fff' }}><h2>No scheduled items right now</h2></div>} />
      <button className="btn ghost no-print" style={{ position: 'fixed', right: 8, bottom: 8, opacity: 0.25, color: '#fff' }} onClick={() => document.documentElement.requestFullscreen?.()} aria-label="Full screen"><Maximize size={18} /></button>
    </div>
  );
}
