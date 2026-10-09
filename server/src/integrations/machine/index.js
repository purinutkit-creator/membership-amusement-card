// Machine controller adapter: delivers "Allow Play" to the physical machine.
//  socket : emits `play:allow` to the terminal page in room machine:<id>; the terminal forwards
//           it to hardware (relay/coin-pulse board) via its local bridge / WebSerial.
//  http   : POSTs to machine config URL (e.g. an IoT relay controller on the LAN).
import { emit } from '../../realtime.js';
import { logger } from '../../lib/logger.js';

export async function allowPlay(machine, payload) {
  emit([`machine:${machine.id}`], 'play:allow', { machineId: machine.id, credits: machine.credits_per_play, ...payload });
  const url = machine.relay_url || machine.config?.relayUrl;
  if (url) {
    try {
      await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credits: machine.credits_per_play, txn: payload.txnNo }) , signal: AbortSignal.timeout(3000) });
    } catch (e) {
      logger.device.error('machine.relay_failed', { machineId: machine.id, message: e.message });
    }
  }
  logger.device.info('machine.play_allowed', { machineId: machine.id, txnNo: payload.txnNo });
}
