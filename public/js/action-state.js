(function initActionState(global) {
  'use strict';

  function setBusy(button, busy) {
    if (!button) return;
    const isBusy = Boolean(busy);
    button.classList.add('ww-busy-button');
    button.classList.toggle('ww-is-busy', isBusy);
    button.disabled = isBusy;
    if (isBusy) {
      button.setAttribute('aria-busy', 'true');
    } else {
      button.removeAttribute('aria-busy');
    }
  }

  global.WolkenworteActions = Object.freeze({ setBusy });
}(window));
