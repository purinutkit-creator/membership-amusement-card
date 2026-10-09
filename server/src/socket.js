import { Server } from 'socket.io';
import { parse as parseCookie } from './lib/cookie.js';
import { resolveSession, loadStaff } from './services/auth.js';
import { resolveDevice, STAFF_COOKIE, MEMBER_COOKIE } from './middleware/auth.js';
import { one, query } from './db/pool.js';
import { sha256 } from './lib/crypto.js';
import { setIO } from './realtime.js';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { notify } from './services/notifications.js';

export function attachSocket(server) {
  const io = new Server(server, { cors: config.corsOrigins.length ? { origin: config.corsOrigins, credentials: true } : undefined, pingInterval: 10000, pingTimeout: 8000 });
  setIO(io);

  io.use(async (socket, next) => {
    try {
      const a = socket.handshake.auth || {};
      const cookies = parseCookie(socket.handshake.headers.cookie || '');
      const rooms = [];
      let identity = null;
      if (a.kind === 'device') {
        const d = await resolveDevice(a.token);
        if (!d || d.status !== 'ACTIVE') return next(new Error('DEVICE_UNAUTHORIZED'));
        identity = { kind: 'device', id: d.id, device: d };
        rooms.push(`device:${d.id}`, 'displays');
        const machines = (await query('SELECT id FROM machines WHERE device_id = $1', [d.id])).rows;
        for (const m of machines) rooms.push(`machine:${m.id}`);
      } else if (a.kind === 'display') {
        const p = await one({ query }, `SELECT p.* FROM sessions s JOIN device_pairings p ON p.id = s.subject_id WHERE s.token_hash = $1 AND s.subject_type = 'DISPLAY' AND s.revoked_at IS NULL AND p.status = 'PAIRED'`, [sha256(a.token || '')]);
        if (!p) return next(new Error('DISPLAY_UNAUTHORIZED'));
        identity = { kind: 'display', id: p.id, pairing: p };
        rooms.push(`pair:${p.id}`, 'displays');
      } else if (a.kind === 'member') {
        const s = await resolveSession(cookies[MEMBER_COOKIE] || a.token, 'MEMBER');
        if (!s) return next(new Error('UNAUTHENTICATED'));
        identity = { kind: 'member', id: s.subject_id };
        rooms.push(`member:${s.subject_id}`);
        const cards = (await query('SELECT id FROM cards WHERE member_id = $1', [s.subject_id])).rows;
        for (const c of cards) rooms.push(`card:${c.id}`);
      } else if (a.kind === 'signage') {
        identity = { kind: 'signage' };
        rooms.push('displays');
      } else {
        const s = await resolveSession(cookies[STAFF_COOKIE] || a.token, 'STAFF');
        if (!s) return next(new Error('UNAUTHENTICATED'));
        const staff = await loadStaff(s.subject_id);
        if (!staff || staff.status !== 'ACTIVE') return next(new Error('UNAUTHENTICATED'));
        identity = { kind: 'staff', id: staff.id, staff };
        rooms.push('staff', `staff:${staff.id}`);
        if (staff.branch_id) rooms.push(`branch:${staff.branch_id}`);
      }
      socket.data.identity = identity;
      socket.data.rooms = rooms;
      next();
    } catch (e) { next(e); }
  });

  io.on('connection', async (socket) => {
    const id = socket.data.identity;
    for (const r of socket.data.rooms) socket.join(r);
    if (id.kind === 'device') {
      await query('UPDATE devices SET online = true, last_online_at = now(), ip = $2 WHERE id = $1', [id.id, socket.handshake.address]);
      await query('UPDATE machines SET online = true, last_seen_at = now() WHERE device_id = $1', [id.id]);
      io.to('staff').emit('device:status', { deviceId: id.id, online: true });
    }
    if (id.kind === 'display') io.to(`staff:${id.pairing.staff_id}`).emit('pair:connected', { pairingId: id.id });

    // staff may subscribe to card / order / redemption rooms they are looking at
    socket.on('watch', (room) => {
      if (id.kind !== 'staff' || typeof room !== 'string') return;
      if (/^(card|order|redemption|machine):[0-9a-f-]{36}$/.test(room)) socket.join(room);
    });
    socket.on('unwatch', (room) => { if (typeof room === 'string') socket.leave(room); });
    socket.on('heartbeat', async () => {
      if (id.kind === 'device') await query('UPDATE devices SET online = true, last_online_at = now() WHERE id = $1', [id.id]).catch(() => {});
    });

    socket.on('disconnect', async () => {
      if (id.kind === 'device') {
        const still = [...(await io.in(`device:${id.id}`).fetchSockets())].length;
        if (still) return;
        await query('UPDATE devices SET online = false WHERE id = $1', [id.id]).catch(() => {});
        const ms = (await query('UPDATE machines SET online = false WHERE device_id = $1 RETURNING id, name', [id.id]).catch(() => ({ rows: [] }))).rows;
        io.to('staff').emit('device:status', { deviceId: id.id, online: false });
        for (const m of ms) {
          io.to('staff').emit('machine:update', { machineId: m.id, online: false });
          await notify({ query }, { audience: 'ALL_STAFF', type: 'MACHINE_OFFLINE', title: `Machine offline: ${m.name}`, data: { machineId: m.id } }).catch(() => {});
        }
        logger.device.warn('device.disconnected', { deviceId: id.id });
      }
      if (id.kind === 'display') io.to(`staff:${id.pairing.staff_id}`).emit('pair:disconnected', { pairingId: id.id });
    });
  });
  return io;
}
