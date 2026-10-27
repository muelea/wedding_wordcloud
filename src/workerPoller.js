'use strict';

// Event-triggered work stays immediate. Only the durable safety poll backs off.
function create({ run, onError, activeMs = 5_000, idleMs = 60_000 }) {
  let timer = null;
  let started = false;
  function arm(delay) {
    if (!started) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      let result = 0;
      try { result = await run(); } catch (error) { onError(error); }
      const delay = Number.isFinite(result?.nextAt)
        ? Math.min(idleMs,Math.max(activeMs,result.nextAt-Date.now()))
        : (result?.claimed || typeof result === 'number' && result) ? activeMs : idleMs;
      if (!timer) arm(delay);
    }, delay);
    timer.unref?.();
  }
  return {
    start() { if (started) return false; started = true; arm(idleMs); return true; },
    active() { arm(activeMs); },
    stop() { started = false; clearTimeout(timer); timer = null; },
  };
}
module.exports = { create };
