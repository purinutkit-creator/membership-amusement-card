// Realtime hub (Socket.IO). Rooms:
//  staff            all signed-in staff dashboards
//  branch:<id>      staff of a branch
//  card:<id>        anyone watching a card (portal, terminal, POS)
//  member:<id>      member portal sessions
//  machine:<id>     card tap terminal for a machine (receives play:allow)
//  device:<id>      a specific device
//  pair:<id>        a POS <-> customer display pairing
let io = null;
const queue = [];

export function setIO(instance) { io = instance; }
export function getIO() { return io; }

export function emit(rooms, event, data) {
  if (!io) return;
  const list = (Array.isArray(rooms) ? rooms : [rooms]).filter(Boolean);
  if (!list.length) return;
  let target = io;
  for (const r of list) target = target.to(r);
  target.emit(event, data);
}

export { queue };
