(function () {
  'use strict';

  const buttons = Array.from(document.querySelectorAll('[data-ww-install]'));
  if (!buttons.length || !window.isSecureContext) return;
  if (!window.WolkenworteDevice?.isMobileDevice(navigator)) return;
  const ios = window.WolkenworteDevice.isIosDevice(navigator);
  const dialog = document.querySelector('[data-ww-install-dialog]');
  // Keep the modal outside collapsible navigation and its layout rules.
  if (dialog) document.body.append(dialog);
  const standalone = window.matchMedia('(display-mode: standalone)');
  let installPrompt = null;
  let installed = false;
  let prompting = false;

  function inAppWindow() {
    return installed || standalone.matches || navigator.standalone === true;
  }

  function updateButtons() {
    const available = Boolean(installPrompt) || (ios && typeof dialog?.showModal === 'function');
    for (const button of buttons) button.hidden = inAppWindow() || prompting || !available;
    if (inAppWindow() && dialog?.open) dialog.close();
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    if (inAppWindow()) return;
    event.preventDefault();
    installPrompt = event;
    updateButtons();
  });

  window.addEventListener('appinstalled', () => {
    installed = true;
    installPrompt = null;
    if (dialog?.open) dialog.close();
    updateButtons();
  });
  standalone.addEventListener('change', updateButtons);
  window.addEventListener('pageshow', updateButtons);

  for (const button of buttons) {
    button.addEventListener('click', async () => {
      if (inAppWindow() || prompting) return;
      if (!installPrompt) {
        if (ios && typeof dialog?.showModal === 'function' && !dialog.open) dialog.showModal();
        return;
      }
      // Native prompt events are single-use, including after dismissal/error.
      const prompt = installPrompt;
      installPrompt = null;
      prompting = true;
      updateButtons();
      try {
        const response = await prompt.prompt();
        const result = prompt.userChoice ? await prompt.userChoice : response;
        if (result?.outcome === 'accepted') installed = true;
      } catch {
        // The browser may withdraw installability before the click.
      } finally {
        prompting = false;
        updateButtons();
      }
    });
  }
  dialog?.querySelector('[data-ww-install-close]')?.addEventListener('click', () => dialog.close());
  dialog?.addEventListener('keydown', (event) => {
    // Let Escape dismiss the native dialog without also collapsing its opener's menu.
    if (event.key === 'Escape') event.stopPropagation();
  });
  updateButtons();
})();
