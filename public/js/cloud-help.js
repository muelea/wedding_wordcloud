(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WolkenworteCloudHelp = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  function create({ window: win = window } = {}) {
    const doc = win.document;
    const get = (id) => doc.getElementById(id);
    const tip = get('cloud-tour-tip');
    if (!tip) return null;
    const input = get('display-word-input');
    const menu = doc.querySelector('[data-ww-site-menu]');
    const helpButton = get('cloud-help-button');
    const shareDialog = get('share-dialog');
    const shade = get('cloud-tour-shade');
    const ring = get('cloud-tour-ring');
    const title = get('cloud-tour-title');
    const description = get('cloud-tour-description');
    const progress = get('cloud-tour-progress');
    const next = get('cloud-tour-next');
    const back = get('cloud-tour-back');
    const cleanups = [];
    let step = -1;
    let target = null;
    let describedElement = null;
    let previousDescription = null;
    let returnFocus = null;
    let menuWasOpen = false;
    let frame = 0;
    let destroyed = false;
    const steps = [
      ['Füge ein Wort hinzu', 'Tippe unten ein Wort ein und wähle „Hinzufügen“. Es erscheint sofort bei allen.', '.display-word-entry'],
      ['Lade andere ein', 'Über „Teilen“ teilst du den Link oder zeigst den QR-Code. Gäste brauchen weder Konto noch PIN.', '#share-cloud'],
      ['Zeigen und verwalten', 'Präsentationsmodus für den großen Bildschirm. Im Organisatorbereich verwaltest du die Wolke mit deiner PIN.', '.ww-display-organizer-tools'],
      ['Erinnerung gestalten', 'Gestaltet mit euren Wörtern ein persönliches Andenken. Der Button wird aktiv, sobald die Wolke Wörter enthält.', '#memory-cta'],
    ];
    function listen(element, name, handler, options) {
      element?.addEventListener(name, handler, options);
      cleanups.push(() => element?.removeEventListener(name, handler, options));
    }
    function setText(element, source, params = {}) {
      if (win.WolkenworteI18n?.setText) win.WolkenworteI18n.setText(element, source, params);
      else element.textContent = source.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? '');
    }
    function focusFallback() {
      const element = returnFocus?.isConnected && returnFocus !== doc.body && !returnFocus.closest('[hidden], dialog:not([open])') ? returnFocus : helpButton;
      element?.focus({ preventScroll: true });
    }
    function removeDescription() {
      if (!describedElement) return;
      if (previousDescription === null) describedElement.removeAttribute('aria-describedby');
      else describedElement.setAttribute('aria-describedby', previousDescription);
      describedElement = null;
    }
    function hideSpotlight() { tip.hidden = shade.hidden = ring.hidden = true; }
    function closeTour({ restoreFocus = true } = {}) {
      if (step < 0) return;
      step = -1;
      removeDescription();
      hideSpotlight();
      doc.body.classList.remove('cloud-tour-open');
      if (menu) menu.open = menuWasOpen;
      target = null;
      if (restoreFocus) focusFallback();
    }
    function viewport() {
      const visual = win.visualViewport;
      return { left: (visual?.offsetLeft || 0) + 8, top: (visual?.offsetTop || 0) + 8,
        width: Math.max(1, (visual?.width || win.innerWidth) - 16),
        height: Math.max(1, (visual?.height || win.innerHeight) - 16) };
    }
    function box(element, left, top, width, height) {
      Object.assign(element.style, { left: `${left}px`, top: `${top}px`, width: `${Math.max(0, width)}px`, height: `${Math.max(0, height)}px` });
    }
    function place() {
      frame = 0;
      if (destroyed) return;
      const visual = win.visualViewport;
      const keyboard = doc.activeElement === input && visual && win.innerHeight - visual.height - visual.offsetTop > 100;
      doc.body.classList.toggle('cloud-keyboard-open', Boolean(keyboard));
      if (step < 0) return;
      if (shareDialog.open) { hideSpotlight(); return; }
      if (step === 2 && menu && !menu.open) { closeTour(); return; }
      const bounds = viewport();
      const right = bounds.left + bounds.width;
      const bottom = bounds.top + bounds.height;
      const rect = target.getBoundingClientRect();
      const left = Math.max(bounds.left, Math.min(rect.left - 6, right));
      const top = Math.max(bounds.top, Math.min(rect.top - 6, bottom));
      const endX = Math.max(left, Math.min(rect.right + 6, right));
      const endY = Math.max(top, Math.min(rect.bottom + 6, bottom));
      if (endX <= left || endY <= top) { hideSpotlight(); return; }
      tip.hidden = shade.hidden = ring.hidden = false;
      box(ring, left, top, endX - left, endY - top);
      const shadeWidth = Math.max(win.innerWidth, right);
      const shadeHeight = Math.max(win.innerHeight, bottom);
      const radius = Math.min(parseFloat(win.getComputedStyle(ring).borderTopLeftRadius) || 14, (endX - left) / 2, (endY - top) / 2);
      box(shade, 0, 0, shadeWidth, shadeHeight);
      // Match the ring's rounded opening. Only the painted shade intercepts
      // clicks, so the highlighted control stays interactive.
      shade.querySelector('path').setAttribute('d', [
        `M0 0H${shadeWidth}V${shadeHeight}H0Z`,
        `M${left + radius} ${top}H${endX - radius}A${radius} ${radius} 0 0 1 ${endX} ${top + radius}`,
        `V${endY - radius}A${radius} ${radius} 0 0 1 ${endX - radius} ${endY}`,
        `H${left + radius}A${radius} ${radius} 0 0 1 ${left} ${endY - radius}`,
        `V${top + radius}A${radius} ${radius} 0 0 1 ${left + radius} ${top}Z`,
      ].join(' '));
      const width = Math.min(360, bounds.width - 8);
      tip.style.width = `${width}px`;
      tip.style.maxHeight = `${bounds.height}px`;
      const height = tip.getBoundingClientRect().height;
      let x = Math.max(bounds.left, Math.min(left + (endX - left - width) / 2, right - width));
      let y;
      let available;
      if (left - bounds.left >= width + 12) {
        x = left - width - 12;
        y = Math.max(bounds.top, Math.min(top, bottom - height));
        available = bounds.height;
      } else {
        const above = top - bounds.top - 12;
        const below = bottom - endY - 12;
        const useAbove = above >= height || above >= below;
        available = Math.max(0, useAbove ? above : below);
        y = useAbove ? top - Math.min(height, available) - 12 : endY + 12;
      }
      tip.style.maxHeight = `${available}px`;
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    }
    function schedulePlace() {
      if (!frame && !destroyed) frame = win.requestAnimationFrame(place);
    }
    function showStep(index, { focus = true } = {}) {
      removeDescription();
      step = Math.max(0, Math.min(steps.length - 1, index));
      const [heading, copy, selector] = steps[step];
      if (menu) menu.open = step === 2;
      target = doc.querySelector(selector);
      if (!target) { closeTour(); return; }
      setText(title, heading);
      setText(description, copy);
      setText(progress, 'Schritt {{current}} von {{total}}', { current: step + 1, total: steps.length });
      setText(next, 'Weiter');
      back.hidden = step === 0;
      describedElement = step === 0 ? input : target;
      previousDescription = describedElement.getAttribute('aria-describedby');
      describedElement.setAttribute('aria-describedby', [previousDescription, description.id].filter(Boolean).join(' '));
      doc.body.classList.add('cloud-tour-open');
      if (step === 2) target.scrollIntoView?.({ block: 'nearest' });
      place();
      schedulePlace();
      if (focus) title.focus({ preventScroll: true });
    }
    function startTour(event) {
      if (destroyed) return;
      closeTour({ restoreFocus: false });
      returnFocus = event?.currentTarget || doc.activeElement;
      menuWasOpen = Boolean(menu?.open);
      if (doc.body.classList.contains('presentation-mode')) get('presentation-mode-button').click();
      showStep(0);
    }
    function wordAccepted() {
      if (step === 0) {
        input.blur();
        showStep(1);
      }
    }
    doc.querySelectorAll('[data-cloud-tour-start]').forEach((button) => listen(button, 'click', startTour));
    listen(get('cloud-tour-close'), 'click', () => closeTour());
    listen(back, 'click', () => showStep(step - 1));
    listen(next, 'click', () => step === steps.length - 1 ? closeTour() : showStep(step + 1));
    listen(shade, 'click', () => closeTour());
    // Keep the shared menu open while using the tour controls beside it.
    listen(tip, 'pointerdown', (event) => event.stopPropagation());
    listen(shareDialog, 'close', () => {
      if (step < 0 && (doc.activeElement === doc.body || doc.activeElement?.closest('dialog:not([open]), [hidden]'))) {
        get('share-cloud').focus({ preventScroll: true });
      }
    });
    listen(input, 'focus', schedulePlace);
    listen(input, 'blur', schedulePlace);
    listen(doc, 'wolkenworte:wordaccepted', wordAccepted);
    listen(win, 'wolkenworte:localechange', () => { if (step >= 0) showStep(step, { focus: false }); });
    listen(doc, 'keydown', (event) => {
      if (step < 0 || doc.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeTour();
      } else if (event.key === 'Tab' && !tip.hidden) {
        const focusable = [target, tip].flatMap((area) => [...area.querySelectorAll('button:not([disabled]), input:not([disabled]), summary, a[href]'), ...(area.matches('button:not([disabled]), input:not([disabled])') ? [area] : [])])
          .filter((element) => !element.closest('[hidden]') && element.getClientRects().length);
        const index = focusable.indexOf(doc.activeElement);
        if (focusable.length && (index < 0 || (!event.shiftKey && index === focusable.length - 1) || (event.shiftKey && index === 0))) {
          event.preventDefault(); (event.shiftKey ? focusable.at(-1) : focusable[0]).focus();
        }
      }
    }, true);
    listen(win, 'resize', schedulePlace);
    listen(win, 'scroll', schedulePlace, true);
    listen(win.visualViewport, 'resize', schedulePlace);
    listen(win.visualViewport, 'scroll', schedulePlace);
    listen(menu, 'toggle', schedulePlace);
    const geometryObserver = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedulePlace) : null;
    // Organizer controls can appear after the event metadata arrives. Keep the
    // opening aligned when that happens or when translated text wraps.
    [doc.querySelector('.display-word-entry-row'), doc.querySelector('.ww-display-organizer-tools'), get('memory-cta'), tip]
      .forEach((element) => { if (element) geometryObserver?.observe(element); });
    const observer = new win.MutationObserver(() => {
      if (doc.body.classList.contains('presentation-mode')) {
        closeTour({ restoreFocus: false });
      } else if (step >= 0) {
        if ([...doc.querySelectorAll('dialog[open]')].some((dialog) => dialog !== shareDialog)) closeTour({ restoreFocus: false });
        else if (shareDialog.open) hideSpotlight();
        else schedulePlace();
      }
    });
    observer.observe(doc.body, { attributes: true, attributeFilter: ['class'] });
    doc.querySelectorAll('dialog').forEach((dialog) => observer.observe(dialog, { attributes: true, attributeFilter: ['open'] }));
    listen(win, 'pagehide', () => closeTour({ restoreFocus: false }));
    // This is a one-use presentation hint, never an organizer credential. Share
    // URLs come from the canonical event URL, which has no fragment.
    if (win.location.hash === '#willkommen') {
      try { win.history.replaceState(win.history.state, '', win.location.pathname + win.location.search); } catch {}
      startTour();
    }
    return { startTour, closeTour, wordAccepted, destroy() {
      closeTour({ restoreFocus: false }); destroyed = true;
      observer.disconnect(); geometryObserver?.disconnect(); cleanups.forEach((cleanup) => cleanup());
      if (frame) win.cancelAnimationFrame(frame);
      doc.body.classList.remove('cloud-keyboard-open');
    } };
  }
  return { create };
}));
