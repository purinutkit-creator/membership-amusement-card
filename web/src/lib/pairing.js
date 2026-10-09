// POS side of the Customer Display pairing: create 6-digit code, push live state, receive customer input.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { useSocket } from './realtime.js';

export function usePairing(onInput) {
  const [pairing, setPairing] = useState(null);
  const inputRef = useRef(onInput);
  inputRef.current = onInput;
  const last = useRef(null);

  const load = useCallback(() => api.get('/pairings/current').then(setPairing).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  useSocket({
    'pair:connected': () => load(),
    'pair:disconnected': () => setPairing((p) => (p ? { ...p, displayOnline: false } : p)),
    'display:input': (e) => inputRef.current?.(e),
  });

  const create = async () => { const p = await api.post('/pairings'); setPairing(p); return p; };
  const close = async () => { if (pairing) await api.post(`/pairings/${pairing.id}/close`).catch(() => {}); setPairing(null); };
  /** Push state (deduplicated) to the paired display. */
  const push = useCallback(async (state) => {
    if (pairing?.status !== 'PAIRED') return;
    const s = JSON.stringify(state);
    if (s === last.current) return;
    last.current = s;
    await api.post(`/pairings/${pairing.id}/state`, state).catch(() => {});
  }, [pairing]);
  return { pairing, create, close, push, paired: pairing?.status === 'PAIRED', reload: load };
}
