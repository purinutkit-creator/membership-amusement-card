import { io } from 'socket.io-client';
import { useEffect, useRef, useState } from 'react';

const sockets = new Map();

/** One shared socket per auth identity (staff / member / device:<token> / display:<token>). */
export function getSocket(auth = { kind: 'staff' }) {
  const key = `${auth.kind}:${auth.token || ''}`;
  if (sockets.has(key)) return sockets.get(key);
  const s = io({ path: '/socket.io', auth, transports: ['websocket', 'polling'], reconnectionDelayMax: 4000 });
  sockets.set(key, s);
  return s;
}
export function closeSocket(auth = { kind: 'staff' }) {
  const key = `${auth.kind}:${auth.token || ''}`;
  sockets.get(key)?.close();
  sockets.delete(key);
}

/** Subscribe to events. handlers: { event: fn }. */
export function useSocket(handlers, auth = { kind: 'staff' }, deps = []) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (auth === null) return undefined;
    const s = getSocket(auth);
    const onC = () => setConnected(true); const onD = () => setConnected(false);
    s.on('connect', onC); s.on('disconnect', onD);
    setConnected(s.connected);
    const wrapped = Object.keys(ref.current).map((ev) => { const fn = (...a) => ref.current[ev]?.(...a); s.on(ev, fn); return [ev, fn]; });
    return () => { s.off('connect', onC); s.off('disconnect', onD); for (const [ev, fn] of wrapped) s.off(ev, fn); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.kind, auth?.token, ...deps]);
  return connected;
}

/** Ask the server to join a watch room (card:<id>, order:<id>, ...). */
export function useWatch(room) {
  useEffect(() => {
    if (!room) return undefined;
    const s = getSocket({ kind: 'staff' });
    const join = () => s.emit('watch', room);
    join(); s.on('connect', join);
    return () => { s.emit('unwatch', room); s.off('connect', join); };
  }, [room]);
}
