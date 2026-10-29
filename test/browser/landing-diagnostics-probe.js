'use strict';

// Local fixture only. Bounded breadcrumbs may survive a tab reload, but are
// best-effort and cannot identify an OS/GPU process termination by themselves.
(function () {
  const key = 'wolkenworte-local-landing-diagnosis';
  const mode = document.currentScript.dataset.omitted || 'baseline';
  let entries;
  try { entries = JSON.parse(sessionStorage.getItem(key)); } catch {}
  if (!Array.isArray(entries)) entries = [];
  entries = entries.slice(-39);
  let output, lastScroll = 0;
  function record(event) {
    // Deliberately no form values, page text, PINs or exception messages.
    entries.push({ time: new Date().toISOString(), mode, event, y: Math.round(window.scrollY) });
    entries = entries.slice(-40);
    try { sessionStorage.setItem(key, JSON.stringify(entries)); } catch {}
  }
  function report() {
    return JSON.stringify({ userAgent: navigator.userAgent, mode,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: window.visualViewport?.scale || 1 },
      fallback: document.querySelector('#word-demo')?.getAttribute('data-demo-fallback') || null,
      video: Array.from(document.querySelectorAll('video')).map(video => ({
        width: video.videoWidth, height: video.videoHeight, paused: video.paused, readyState: video.readyState,
      })),
      // Attached canvases only; this is not a measurement of total GPU memory.
      canvases: Array.from(document.querySelectorAll('canvas')).map(canvas => ({ width: canvas.width, height: canvas.height })),
      entries,
    }, null, 2);
  }
  record('load');
  window.addEventListener('error', () => record('error'), true);
  window.addEventListener('unhandledrejection', () => record('unhandledrejection'));
  window.addEventListener('pagehide', () => record('pagehide'));
  window.addEventListener('pageshow', () => record('pageshow'));
  window.addEventListener('scroll', () => {
    if (performance.now() - lastScroll < 500) return;
    lastScroll = performance.now(); record('scroll');
  }, { passive: true });
  document.addEventListener('visibilitychange', () => record(document.hidden ? 'hidden' : 'visible'));
  document.addEventListener('webglcontextlost', () => record('webglcontextlost'), true);
  document.addEventListener('webglcontextrestored', () => record('webglcontextrestored'), true);
  document.addEventListener('click', event => {
    if (event.target.closest('[data-open-start-dialog]')) record('start-dialog-open');
    if (event.target.closest('#start-dialog-close')) record('start-dialog-close');
  }, true);
  document.addEventListener('submit', event => {
    if (event.target.id === 'start-dialog-form') record('start-form-submit');
  }, true);
  document.addEventListener('DOMContentLoaded', () => {
    const panel = document.createElement('details');
    panel.id = 'landing-diagnosis';
    panel.style.cssText = 'position:fixed;z-index:2147483647;bottom:8px;left:8px;max-width:calc(100vw - 16px);max-height:45vh;overflow:auto;padding:8px;background:white;color:#222;border:1px solid #777;font:13px system-ui';
    panel.innerHTML = '<summary>Lokale Safari-Diagnose</summary><p>Nur lokaler Test; keine echte Wortwolke. Modus: <b></b></p><nav></nav><p>Nach einem Absturz neu laden und den Bericht öffnen. Ein fehlender Fehler beweist keinen fehlerfreien Ablauf.</p><button type="button">Bericht aktualisieren</button><textarea readonly aria-label="Lokaler Diagnosebericht" style="display:block;width:300px;max-width:100%;height:150px;font:11px monospace"></textarea>';
    panel.querySelector('b').textContent = mode;
    const nav = panel.querySelector('nav');
    for (const [value, label] of [['', 'Original'], ['video', 'Ohne Video'], ['demo', 'Ohne Demo'],
      ['filters', 'Ohne Filter'], ['video,demo,filters', 'Ohne alle drei']]) {
      const link = document.createElement('a');
      link.href = '/?lang=de&omit=' + encodeURIComponent(value);
      link.textContent = label; link.style.cssText = 'display:inline-block;margin:6px;text-decoration:underline'; nav.append(link);
    }
    output = panel.querySelector('textarea');
    panel.addEventListener('toggle', () => { if (panel.open) output.value = report(); });
    panel.querySelector('button').addEventListener('click', () => { output.value = report(); });
    const simulate = document.createElement('button');
    simulate.type = 'button'; simulate.textContent = 'WebGL-Ausfall simulieren';
    simulate.addEventListener('click', () => {
      const canvas = document.querySelector('[data-demo-mug-viewer] canvas[data-product-mesh]');
      const context = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
      const extension = context?.getExtension('WEBGL_lose_context');
      if (!extension) { record('simulation-unavailable'); output.value = report(); return; }
      record('simulate-context-loss');
      extension.loseContext();
    });
    panel.insertBefore(simulate, output);
    document.body.append(panel);
  });
})();
