// Plays an approved, currently-scheduled playlist: images (duration), videos (full length), text slides (multi-language).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useSocket } from '../lib/realtime.js';

export default function SignagePlayer({ playlistId, lang = 'th', fallback = null, style }) {
  const [items, setItems] = useState([]);
  const [i, setI] = useState(0);
  const timer = useRef(null);
  const load = useCallback(() => {
    if (!playlistId) return;
    api.get(`/public/playlists/${playlistId}/now`).then((r) => { setItems(r.items); setI(0); }).catch(() => setItems([]));
  }, [playlistId]);
  useEffect(() => { load(); const t = setInterval(load, 5 * 60000); return () => clearInterval(t); }, [load]); // re-evaluate schedules
  useSocket({ 'playlist:update': (e) => (!e.playlistId || e.playlistId === playlistId) && load() }, { kind: 'signage' }, [playlistId]);
  const next = useCallback(() => setI((x) => (items.length ? (x + 1) % items.length : 0)), [items.length]);
  const cur = items[i];
  useEffect(() => {
    clearTimeout(timer.current);
    if (!cur) return undefined;
    if (cur.item_type === 'VIDEO' && !cur.duration_sec) return undefined; // advance on ended
    timer.current = setTimeout(next, (cur.duration_sec || 10) * 1000);
    return () => clearTimeout(timer.current);
  }, [cur, next]);
  if (!cur) return fallback;
  const pick = (o) => (o ? o[lang] || o.en || o.th || Object.values(o)[0] : '');
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: '#000', ...style }}>
      <div key={`${cur.id}-${i}`} className="signage-item">
        {cur.item_type === 'IMAGE' && <img src={cur.url} alt="" />}
        {cur.item_type === 'VIDEO' && <video src={cur.url} autoPlay muted playsInline onEnded={next} onError={next} />}
        {cur.item_type === 'TEXT' && (
          <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '6vw', background: cur.text_content?.background || 'var(--primary)', color: cur.text_content?.color || '#fff' }}>
            <div className="giant">{pick(cur.text_content?.title)}</div>
            <div className="huge" style={{ opacity: 0.9, marginTop: 20 }}>{pick(cur.text_content?.subtitle)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
