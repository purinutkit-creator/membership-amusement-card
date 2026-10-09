import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, setApprovalHandler } from './api.js';
import { applyTheme, applyFont, setFavicon } from './theme.js';
import { setCurrency } from './format.js';
import { configureSounds } from './sound.js';
import { closeSocket } from './realtime.js';
import { ApprovalModal } from '../components/domain.jsx';

const Ctx = createContext(null);
const mediaUrl = (id) => (id ? `/api/public/media/${id}` : null);

export function applyPublicSettings(settings, surface = 'dashboard') {
  if (!settings) return;
  applyTheme(settings.theme);
  const fonts = structuredClone(settings.fonts || {});
  for (const v of Object.values(fonts)) if (v?.source === 'custom' && v.mediaId) v.mediaUrl = mediaUrl(v.mediaId);
  applyFont(surface, fonts);
  setCurrency(settings.general?.currencySymbol);
  configureSounds(settings.sound, mediaUrl);
  if (settings.branding?.faviconMediaId) setFavicon(mediaUrl(settings.branding.faviconMediaId));
  document.title = settings.general?.storeName || 'Smart Card Platform';
}

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, staff: null, settings: null, locked: false, security: null });
  const [approval, setApproval] = useState(null);
  const approvalResolve = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get('/auth/me');
      setState({ loading: false, staff: me.staff, settings: me.settings, locked: !!me.locked, security: me.security, branchId: me.branchId });
      applyPublicSettings(me.settings, 'dashboard');
      return me;
    } catch {
      setState((s) => ({ ...s, loading: false, staff: null }));
      return null;
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    setApprovalHandler((req) => new Promise((resolve) => { approvalResolve.current = resolve; setApproval(req); }));
    const onUnauth = () => setState((s) => (s.staff ? { ...s, locked: s.locked, staff: null } : s));
    window.addEventListener('sc:unauthenticated', onUnauth);
    return () => window.removeEventListener('sc:unauthenticated', onUnauth);
  }, []);

  // idle auto-lock (Settings > Security > Auto lock minutes)
  const lockMin = state.security?.autoLockMinutes;
  useEffect(() => {
    if (!state.staff || !lockMin) return undefined;
    let t;
    const reset = () => { clearTimeout(t); t = setTimeout(() => lock(), lockMin * 60000); };
    const evs = ['pointerdown', 'keydown', 'touchstart'];
    evs.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => { clearTimeout(t); evs.forEach((e) => window.removeEventListener(e, reset)); };
  }, [state.staff, lockMin]); // eslint-disable-line react-hooks/exhaustive-deps

  const login = async (body) => { const r = await api.post('/auth/login', body); closeSocket(); await refresh(); return r; };
  const logout = async () => { await api.post('/auth/logout').catch(() => {}); closeSocket(); setState((s) => ({ ...s, staff: null, locked: false })); };
  const lock = async () => { await api.post('/auth/lock').catch(() => {}); setState((s) => ({ ...s, locked: true })); };
  const unlock = async (pin) => { await api.post('/auth/unlock', { pin }); setState((s) => ({ ...s, locked: false })); };
  const switchStaff = async (employeeCode, pin) => { await api.post('/auth/switch', { employeeCode, pin }); closeSocket(); await refresh(); };
  const can = useCallback((p) => !!state.staff && (state.staff.isOwner || state.staff.permissions?.includes(p)), [state.staff]);
  const canAny = useCallback((...ps) => ps.some((p) => can(p)), [can]);

  return (
    <Ctx.Provider value={{ ...state, refresh, login, logout, lock, unlock, switchStaff, can, canAny, mediaUrl }}>
      {children}
      <ApprovalModal request={approval} onDone={(v) => { setApproval(null); approvalResolve.current?.(v); }} />
    </Ctx.Provider>
  );
}
export const useAuth = () => useContext(Ctx);
