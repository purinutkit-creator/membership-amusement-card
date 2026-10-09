// Feedback sounds. Uses the custom sound uploaded in Settings > Sound when present,
// otherwise a generated tone (no asset needed).
let ctx = null;
let custom = {};
let enabled = true;
export function configureSounds(settings, urlFor) {
  enabled = settings?.enabled !== false;
  custom = {};
  for (const k of ['tap', 'success', 'error', 'lowBalance', 'paymentSuccess']) if (settings?.[k]) custom[k] = urlFor(settings[k]);
}
const TONES = { tap: [[880, 0.06]], success: [[660, 0.09], [880, 0.09], [1320, 0.16]], error: [[220, 0.18], [180, 0.28]], lowBalance: [[440, 0.12], [330, 0.2]], paymentSuccess: [[523, 0.1], [659, 0.1], [784, 0.1], [1047, 0.22]] };
export function play(kind) {
  if (!enabled) return;
  if (custom[kind]) { const a = new Audio(custom[kind]); a.play().catch(() => {}); return; }
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    let t = ctx.currentTime;
    for (const [f, d] of TONES[kind] || TONES.tap) {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + d);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + d); t += d * 0.9;
    }
  } catch { /* audio not available */ }
}
