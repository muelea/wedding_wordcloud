(function(root) {
  'use strict';
  const i18n = () => root.WolkenworteI18n;
  const text = (element, source, params = {}) => {
    if (i18n()?.setText) i18n().setText(element, source, params);
    else element.textContent = source.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? '');
  };
  const api = (path, body) => root.WolkenworteAccount.api(path, body);
  const date = value => new Intl.DateTimeFormat(i18n()?.getLocale() || 'de', {dateStyle:'medium'}).format(new Date(value));
  const element = (tag, className = '') => Object.assign(document.createElement(tag), {className});

  function card(cloud, {picker = false, remove} = {}) {
    const article = element('article', 'ww-account-design ww-cloud-card');
    const preview = element('div', 'ww-cloud-preview');
    preview.setAttribute('aria-hidden', 'true');
    const words = cloud.available ? cloud.previewWords || [] : [];
    const maximum = Math.max(1, ...words.map(pair => pair[1]));
    const colors = ['#9c1c4c', '#c26a43', '#5c7470', '#705b8b', '#b07832'];
    words.forEach(([word, count], index) => {
      const span = element('span'); span.textContent = word;
      span.style.fontSize = `${14 + 16 * Math.sqrt(count / maximum)}px`;
      span.style.color = colors[index % colors.length];
      preview.append(span);
    });
    if (!words.length) text(preview, cloud.available ? 'Noch keine Wörter' : 'Nicht mehr verfügbar');
    const heading = element('h2'); heading.textContent = cloud.title;
    const description = element('p', 'ww-account-small');
    text(description, cloud.available ? 'Verfügbar bis {{date}}, sofern keine weiteren Änderungen erfolgen.' : 'Diese Wortwolke ist nicht mehr verfügbar.',
      cloud.available ? {date:date(cloud.expiresAt)} : {});
    const actions = element('div', 'ww-account-actions');
    const link = (label, href, primary = false) => {
      const a = element('a', primary ? 'ww-cloud-action ww-account-primary' : 'ww-cloud-action');
      a.href = href; text(a, label); actions.append(a);
    };
    if (cloud.available) {
      if (!picker) link('Wortwolke öffnen', cloud.url, true);
      if (words.length) link('Damit gestalten', cloud.designUrl, picker);
      else {
        const empty = element('p', 'ww-account-small');
        text(empty, 'Sobald die Wortwolke Wörter enthält, kannst du damit gestalten.');
        article.append(empty);
        if (picker) link('Wortwolke öffnen', cloud.url);
      }
    }
    article.prepend(preview, heading, description);
    article.append(actions);
    if (remove) {
      const button = element('button', 'ww-account-link ww-cloud-remove');
      button.type = 'button'; text(button, 'Aus Konto entfernen');
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await remove(cloud); }
        finally { button.disabled = false; }
      });
      article.append(button);
    }
    return article;
  }

  function initializePicker(page) {
    const dialog = document.getElementById('account-design-picker');
    if (!dialog) return;
    const selection = dialog.querySelector('[data-design-picker-selection]');
    const notice = dialog.querySelector('[data-design-picker-status]');
    const retry = dialog.querySelector('[data-design-picker-retry]');
    const list = dialog.querySelector('[data-design-picker-list]');
    const choices = dialog.querySelector('[data-design-picker-choices]');
    const back = dialog.querySelector('[data-design-picker-back]');
    let generation = 0;
    const start = () => {
      selection.hidden = true; choices.hidden = false; back.hidden = true;
      list.replaceChildren(); generation++;
      text(dialog.querySelector('h2'), 'Wie möchtest du starten?');
    };
    page.querySelectorAll('[data-account-new-design]').forEach(form => form.addEventListener('submit', event => {
      event.preventDefault(); start();
      dialog.showModal(); dialog.querySelector('h2').focus();
    }));
    back.addEventListener('click', () => {start();dialog.querySelector('h2').focus();});
    dialog.querySelector('[data-design-picker-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { generation++; });
    const load = async () => {
      const revision = ++generation;
      choices.hidden = true; back.hidden = false;
      text(dialog.querySelector('h2'), 'Wortwolke auswählen');
      dialog.querySelector('h2').focus();
      selection.hidden = false; retry.hidden = true;
      dialog.querySelector('[data-design-picker-empty]').hidden = true;
      list.replaceChildren(); text(notice, 'Deine Wortwolken werden geladen…');
      try {
        const data = await api('clouds');
        if (revision !== generation || !dialog.open) return;
        data.clouds.forEach(cloud => list.append(card(cloud, {picker:true})));
        dialog.querySelector('[data-design-picker-empty]').hidden = data.clouds.length !== 0;
        text(notice, '');
      } catch (error) {
        if (revision !== generation || !dialog.open) return;
        text(notice, root.WolkenworteAccount.message(error)); retry.hidden = false;
      }
    };
    dialog.querySelector('[data-design-picker-clouds]').addEventListener('click', () => void load());
    retry.addEventListener('click', () => void load());
  }

  async function initializeDisplay() {
    const button = document.querySelector('[data-cloud-bookmark]');
    const dialog = document.getElementById('cloud-bookmark-auth');
    if (!button || !dialog) return;
    await i18n()?.ready?.();
    const slug = location.pathname.split('/')[2];
    const savedLink = document.querySelector('[data-cloud-bookmark-saved]');
    const notice = document.querySelector('[data-cloud-bookmark-status]');
    const feedback = document.querySelector('[data-cloud-bookmark-feedback]');
    let pending = false, revision = 0, feedbackTimer;
    const showSaved = saved => { button.hidden = saved; savedLink.hidden = !saved; };
    function report(source, error = false) {
      for (const node of [notice, feedback].filter(Boolean)) {
        text(node, source); node.hidden = !source; node.dataset.error = String(error);
      }
      clearTimeout(feedbackTimer);
      if (!error) feedbackTimer = setTimeout(() => { if (feedback) feedback.hidden = true; }, 5000);
    }
    async function inspect() {
      const version = ++revision;
      try {
        const {user} = await api('session');
        const data = user && !user.recovery ? await api(`clouds/${slug}`) : {cloud:null};
        if (version === revision) showSaved(Boolean(data.cloud));
      } catch { /* Clicking Save provides an actionable retry if the network is unavailable. */ }
    }
    async function save() {
      if (pending) return;
      pending = true; revision++; button.disabled = true; button.setAttribute('aria-busy', 'true');
      try {
        const {user} = await api('session');
        if (!user || user.recovery) {
          if (user?.recovery) auth.recovery();
          button.closest('[data-ww-site-menu]').open = false;
          dialog.showModal(); return;
        }
        await api('clouds', {slug, ownerId:user.id});
        showSaved(true); report('Der Link zur Wortwolke ist in deinem Konto gespeichert. Ihre Verfügbarkeit bleibt unverändert.');
      } catch (error) { report(root.WolkenworteAccount.message(error), true); }
      finally { pending = false; button.disabled = false; button.setAttribute('aria-busy', 'false'); }
    }
    // Only resume an explicit action from this tab, never a crafted share URL.
    const intentKey = `wolkenworte-cloud-save:${slug}`;
    const intent = Array.from(root.crypto.getRandomValues(new Uint8Array(16)),
      byte => byte.toString(16).padStart(2, '0')).join('');
    const returnQuery = new URLSearchParams(location.search);
    returnQuery.set('cloudSave', intent);
    const returnTo = `${location.pathname}?${returnQuery}`;
    const auth = root.WolkenworteAccount.bindAuth(dialog.querySelector('[data-account-auth]'), {
      returnTo, beforeRedirect:async () => {
        root.sessionStorage.setItem(intentKey, JSON.stringify({token:intent,expiresAt:Date.now()+10*60*1000}));
        return true;
      }, onDone:async () => {
        dialog.close(); await save();
        const {user} = await api('session');
        root.dispatchEvent(new root.CustomEvent('wolkenworte:accountchange', {detail:{user}}));
      },
    });
    dialog.querySelector('[data-cloud-auth-close]').addEventListener('click', () => dialog.close());
    button.addEventListener('click', () => void save());
    root.addEventListener('wolkenworte:accountchange', () => { showSaved(false); void inspect(); });
    root.addEventListener('focus', () => void inspect());
    await inspect();
    const query = new URLSearchParams(location.search);
    if (query.has('cloudSave')) {
      let resume = false;
      try {
        const stored = JSON.parse(root.sessionStorage.getItem(intentKey));
        resume = stored?.token === query.get('cloudSave') && stored.expiresAt > Date.now();
        if (resume) root.sessionStorage.removeItem(intentKey);
      } catch { /* An unavailable browser store cannot authorize an implicit save. */ }
      query.delete('cloudSave');
      history.replaceState(null, '', location.pathname + (query.size ? `?${query}` : '') + (location.hash || ''));
      if (resume) await save();
    }
  }

  root.WolkenworteCloudBookmarks = {card, initializePicker, initializeDisplay};
}(window));
