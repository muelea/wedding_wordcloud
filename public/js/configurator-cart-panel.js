(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WolkenworteCartPanel = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  function create({ dialog, trigger, items, describe, thumbnail, pendingRemoval, onEdit, onRemove, onUndo, onContinue, onQuantity, i18n }) {
    const document = dialog.ownerDocument;
    const window = document.defaultView;
    const list = dialog.querySelector('[data-cart-panel-list]');
    const empty = dialog.querySelector('[data-cart-panel-empty]');
    const status = dialog.querySelector('[data-cart-panel-status]');
    const next = dialog.querySelector('[data-cart-panel-continue]');
    const notice = dialog.querySelector('[data-cart-panel-removal]');
    const undo = notice.querySelector('button');
    trigger.setAttribute('aria-controls', dialog.id);
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    let busy = false;
    let restoreFocusOnClose = true;
    const node = (tag, className, text) => {
      const element = document.createElement(tag);
      element.className = className;
      if (text) i18n.setText(element, text);
      return element;
    };
    const message = text => { status.hidden = !text; if (text) i18n.setText(status, text); };
    function position() {
      const rect = trigger.getBoundingClientRect();
      dialog.style.setProperty('--cart-panel-top', `${Math.max(12, rect.bottom + 12)}px`);
      dialog.style.setProperty('--cart-panel-right', `${Math.max(12, window.innerWidth - rect.right)}px`);
    }
    function render() {
      let rows;
      try { rows = items(); }
      catch {
        list.replaceChildren();
        empty.hidden = true;
        next.disabled = true;
        notice.hidden = true;
        message('Der Warenkorb konnte in diesem Browser nicht geladen werden. Bitte erlaubt das Speichern von Websitedaten.');
        return false;
      }
      list.replaceChildren();
      empty.hidden = rows.length > 0;
      next.disabled = busy || !rows.length;
      dialog.setAttribute('aria-busy', String(busy));
      for (const item of rows) {
        const description = describe(item);
        const row = node('li', 'cart-panel-item');
        row.dataset.configurationId = item.id;
        const image = thumbnail(item);
        const copy = node('div', 'cart-panel-item-copy');
        const name = node('strong', '');
        name.textContent = description.name;
        const size = node('span', '');
        size.textContent = description.size;
        const price = node('span', 'cart-panel-item-price');
        price.textContent = description.price || '';
        price.hidden = !description.price;
        const details = node('div', 'cart-panel-item-details');
        details.append(size);
        if (description.size && description.price) details.append(document.createTextNode(' · '));
        details.append(price);
        const actions = node('div', 'cart-panel-item-actions');
        const edit = node('button', '', 'Design anpassen');
        edit.type = 'button'; edit.disabled = busy;
        i18n.setAttribute(edit, 'aria-label', '{{item}} öffnen und bearbeiten', { item: description.name });
        edit.addEventListener('click', () => { void run(() => onEdit(item.id)); });
        const remove = node('button', 'cart-panel-remove', 'Entfernen');
        remove.type = 'button'; remove.disabled = busy;
        i18n.setAttribute(remove, 'aria-label', '{{item}} aus dem Warenkorb entfernen', { item: description.name });
        remove.addEventListener('click', () => { void run(() => onRemove(item.id)); });
        actions.append(edit, remove);
        copy.append(name, details);
        row.append(image, copy);
        if (onQuantity) {
          const control = node('div', 'cart-panel-quantity');
          const minus = node('button', '', '−');
          const input = node('input', '');
          const plus = node('button', '', '+');
          minus.type = plus.type = 'button';
          input.type = 'number'; input.inputMode = 'numeric';
          input.min = '0'; input.max = String(description.maxQuantity || 99);
          input.step = '1'; input.value = String(description.quantity ?? 1);
          input.dataset.cartQuantity = item.id;
          i18n.setAttribute(input, 'aria-label', 'Menge: {{product}}', { product: description.name });
          i18n.setAttribute(minus, 'aria-label', '{{product}} einmal weniger', { product: description.name });
          i18n.setAttribute(plus, 'aria-label', '{{product}} einmal mehr', { product: description.name });
          input.disabled = busy;
          minus.disabled = busy || Number(input.value) <= 0;
          plus.disabled = busy || Number(input.value) >= Number(input.max);
          const change = value => {
            if (!Number.isInteger(value) || value < 0 || value > Number(input.max)) {
              input.value = String(description.quantity ?? 1); return;
            }
            void run(() => onQuantity(item.id, value));
          };
          minus.addEventListener('click', () => change(Number(input.value) - 1));
          plus.addEventListener('click', () => change(Number(input.value) + 1));
          input.addEventListener('change', () => change(Number(input.value)));
          control.append(minus, input, plus);
          const excluded = node('span', 'cart-panel-excluded', 'Menge 0: nicht in dieser Bestellung enthalten');
          excluded.hidden = Number(input.value) > 0;
          copy.append(excluded);
          row.append(control);
        }
        row.append(actions);
        list.append(row);
      }
      const removed = pendingRemoval();
      notice.hidden = !removed;
      undo.disabled = busy;
      if (removed) i18n.setText(notice.querySelector('span'), '{{item}} wurde aus dem Warenkorb entfernt.', {
        item: describe(removed.item).name,
      });
      return true;
    }
    async function run(action) {
      if (busy) return;
      const focused = document.activeElement;
      const focusedId = focused?.closest('[data-configuration-id]')?.dataset.configurationId;
      const focusIndex = focusedId ? [...focused.closest('[data-configuration-id]').querySelectorAll('button, input')].indexOf(focused) : -1;
      busy = true;
      message('');
      if (!render()) { busy = false; return; }
      try { await action(); }
      catch (error) { message(error.userMessage || 'Der Warenkorb konnte nicht aktualisiert werden. Bitte versucht es erneut.'); }
      finally {
        busy = false;
        if (dialog.open) {
          render();
          const replacement = [...list.children].find(row => row.dataset.configurationId === focusedId)
            ?.querySelectorAll('button, input')[focusIndex];
          if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
          if (!dialog.contains(document.activeElement)) dialog.querySelector('h2').focus({ preventScroll: true });
        }
      }
    }
    function close({ restoreFocus = true } = {}) {
      restoreFocusOnClose = restoreFocus;
      if (dialog.open) dialog.close();
    }
    function open() {
      restoreFocusOnClose = true;
      message('');
      render();
      position();
      if (!dialog.open) dialog.showModal();
      trigger.setAttribute('aria-expanded', 'true');
      dialog.querySelector('h2').focus({ preventScroll: true });
    }
    for (const button of dialog.querySelectorAll('[data-cart-panel-close]')) button.addEventListener('click', close);
    next.addEventListener('click', () => { void run(onContinue); });
    undo.addEventListener('click', () => { void run(onUndo); });
    let backdrop = false;
    const outside = event => {
      const rect = dialog.getBoundingClientRect();
      return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
    };
    dialog.addEventListener('pointerdown', event => { backdrop = outside(event); });
    dialog.addEventListener('click', event => { if (backdrop && outside(event)) close(); backdrop = false; });
    dialog.addEventListener('close', () => {
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocusOnClose && !trigger.hidden) trigger.focus({ preventScroll: true });
    });
    window.addEventListener('resize', position);
    return { open, close, message, refresh: () => { if (dialog.open) render(); } };
  }
  return { create };
});
