(function () {
  'use strict';
  const menus = [...document.querySelectorAll('[data-account-menu]')];
  if (!menus.length) return;
  let current = null;
  let revision = 0;
  let sessionScript;
  const setText = (element, source) => {
    if (window.WolkenworteI18n?.setText) window.WolkenworteI18n.setText(element, source);
    else element.textContent = source;
  };
  function update(user) {
    current = user && !user.recovery ? user : null;
    menus.forEach(menu => { menu.querySelector('[data-account-menu-signed-in]').hidden = !current; });
  }
  async function request(path, body) {
    const response = await fetch(`/api/account/${path}`, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: body === undefined ? {} : {'Content-Type': 'application/json', 'X-Wolkenworte-Account': '1'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('Account menu request failed');
    return response.json();
  }
  async function draftSession(menu) {
    if (window.WolkenworteConfiguratorSession) return window.WolkenworteConfiguratorSession;
    if (!sessionScript) sessionScript = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = menu.dataset.accountSessionUrl;
      script.onload = () => resolve(window.WolkenworteConfiguratorSession);
      script.onerror = reject;
      document.head.append(script);
    }).catch(error => { sessionScript = null; throw error; });
    return sessionScript;
  }
  menus.forEach(menu => {
    const button = menu.querySelector('[data-account-menu-logout]');
    const notice = menu.querySelector('[data-account-menu-status]');
    button.addEventListener('click', async () => {
      if (button.disabled || !current) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      setText(notice, 'Abmelden…');
      try {
        const ownerId = current.id;
        const session = await draftSession(menu);
        await request('logout', {});
        revision++;
        update(null);
        await session.clearAccountDrafts(ownerId);
        location.assign('/');
      } catch {
        setText(notice, 'Das hat leider nicht geklappt. Bitte versuche es erneut.');
      } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      }
    });
  });
  window.addEventListener('wolkenworte:accountchange', event => { revision++; update(event.detail?.user); });
  async function refresh() {
    const requestedRevision = ++revision;
    try {
      const data = await request('session');
      if (revision === requestedRevision) update(data.user);
    } catch {
      if (revision === requestedRevision) update(null);
    }
  }
  window.addEventListener('pageshow', event => { if (event.persisted) void refresh(); });
  void refresh();
})();
