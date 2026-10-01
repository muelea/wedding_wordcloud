(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LiveCloudTransition = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const FADE_OUT_MS = 120;
  const FADE_IN_MS = 180;

  function sameLayout(a, b) {
    return a && b && a.size.width === b.size.width && a.size.height === b.size.height &&
      a.placed.length === b.placed.length && a.placed.every((item, index) => {
        const other = b.placed[index];
        return ['word', 'count', 'x', 'y', 'fontPx', 'rotated', 'color']
          .every(key => item[key] === other[key]);
      });
  }

  function create({ commit, highlight, clearHighlights, setOpacity, isValid,
    motionAllowed, initialWords = [], requestFrame = globalThis.requestAnimationFrame,
    cancelFrame = globalThis.cancelAnimationFrame, now = () => performance.now() }) {
    let displayed = null, pending = null, phase = null, started = 0, frame = null;
    let emphasis = null;
    let counts = new Map(initialWords);
    let disposed = false;

    function stop() {
      if (frame !== null) cancelFrame(frame);
      frame = phase = null;
      emphasis = null;
      setOpacity(1);
    }

    function paint(snapshot, emphasize, deferHighlight = false) {
      if (!snapshot || !isValid(snapshot)) return false;
      const changed = new Set(snapshot.placed.filter(item =>
        Number(item.count) > (counts.get(item.word) || 0)).map(item => item.word));
      clearHighlights();
      emphasis = null;
      commit(snapshot);
      displayed = snapshot;
      counts = new Map(snapshot.placed.map(item => [item.word, Number(item.count)]));
      if (emphasize && changed.size) {
        if (deferHighlight) emphasis = { snapshot, changed };
        else highlight(snapshot, changed);
      }
      return true;
    }

    function start() {
      clearHighlights();
      emphasis = null;
      phase = 'out';
      started = now();
      frame = requestFrame(tick);
    }

    function tick(time) {
      frame = null;
      if (disposed) return;
      if (!motionAllowed()) { finish(); return; }
      if (phase === 'out') {
        if (!pending || !isValid(pending)) { pending = null; stop(); return; }
        const progress = Math.min(1, Math.max(0, (time - started) / FADE_OUT_MS));
        setOpacity(Math.pow(1 - progress, 2));
        if (progress < 1) { frame = requestFrame(tick); return; }
        const next = pending;
        pending = null;
        if (!paint(next, true, true)) { stop(); return; }
        phase = 'in';
        // Begin the reveal from the actual swap frame. Even a late frame must
        // paint the new geometry at zero opacity before bringing it back.
        started = time;
        frame = requestFrame(tick);
        return;
      }
      const progress = Math.min(1, Math.max(0, (time - started) / FADE_IN_MS));
      setOpacity(1 - Math.pow(1 - progress, 2));
      if (progress < 1) frame = requestFrame(tick);
      else {
        phase = null;
        setOpacity(1);
        if (pending) start();
        else {
          if (emphasis && isValid(emphasis.snapshot)) highlight(emphasis.snapshot, emphasis.changed);
          emphasis = null;
        }
      }
    }

    function finish() {
      stop();
      const next = pending;
      pending = null;
      paint(next, false);
      clearHighlights();
    }

    return {
      present(snapshot) {
        if (disposed || !isValid(snapshot)) return;
        if (sameLayout(displayed, snapshot)) {
          pending = null;
          if (phase === 'out') stop();
          return;
        }
        if (!displayed || !motionAllowed()) {
          stop(); pending = null;
          paint(snapshot, motionAllowed());
          return;
        }
        // One latest snapshot during either fade phase. New arrivals never
        // restart the clock or postpone the current layout's reveal.
        pending = snapshot;
        if (!phase) start();
      },
      finish,
      invalidate() { pending = null; stop(); clearHighlights(); },
      reset() {
        pending = displayed = null;
        counts = new Map();
        stop(); clearHighlights();
      },
      dispose() { disposed = true; pending = displayed = null; stop(); clearHighlights(); },
    };
  }
  return { create, sameLayout, FADE_OUT_MS, FADE_IN_MS };
});
