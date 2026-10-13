(function () {
  'use strict';

  var headers = document.querySelectorAll('.ww-site-header');
  if (!headers.length) return;

  function initializeAccountMenu() {
    var groups = [...document.querySelectorAll('[data-account-menu-group]')];
    if (!groups.length) return;
    var user = null, revision = 0, pendingSession = null, pendingLogout = null, pendingDrafts = null;
    var logoutButtons = [...document.querySelectorAll('[data-account-menu-logout], [data-account-logout]')];

    function setText(element, source) {
      if (window.WolkenworteI18n?.setText) window.WolkenworteI18n.setText(element, source);
      else element.textContent = source;
    }
    function showUser(next) {
      user = next && !next.recovery ? next : null;
      groups.forEach(function (group) {
        setText(group.querySelector('[data-account-menu-label]'), user ? 'Mein Konto' : 'Anmelden');
        var email = group.querySelector('[data-account-menu-email]');
        email.textContent = user?.email || '';
        email.hidden = !user;
        group.querySelector('[data-account-menu-logout]').hidden = !user;
      });
    }
    async function request(path, body) {
      var response = await fetch('/api/account/' + path, {
        method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'Accept-Language': window.WolkenworteI18n?.getLocale() || 'de',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Wolkenworte-Account': '1' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
      });
      var data = await response.json();
      if (!response.ok) throw Object.assign(new Error('Account request failed'), { code: data.error, status: response.status });
      return data;
    }
    function session() {
      if (pendingLogout) return pendingLogout.then(function () { return { user: null }; }, function () { return { user: user }; });
      if (pendingSession) return pendingSession;
      var version = revision;
      pendingSession = request('session').then(function (data) {
        // An older request cannot overwrite a completed sign-in or sign-out.
        if (version !== revision) return { user: user };
        showUser(data.user);
        return data;
      }).finally(function () { pendingSession = null; });
      return pendingSession;
    }
    async function draftCleaner() {
      if (window.WolkenworteConfiguratorSession?.clearAccountDrafts) return window.WolkenworteConfiguratorSession.clearAccountDrafts;
      if (!window.indexedDB) return async function () {};
      if (!pendingDrafts) pendingDrafts = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        var timeout = window.setTimeout(function () { script.remove(); reject(new Error('Draft cleanup unavailable')); }, 10000);
        script.src = groups[0].dataset.accountDraftsUrl;
        script.onload = function () {
          window.clearTimeout(timeout);
          var cleaner = window.WolkenworteConfiguratorSession?.clearAccountDrafts;
          if (cleaner) resolve(cleaner); else reject(new Error('Draft cleanup unavailable'));
        };
        script.onerror = function () { window.clearTimeout(timeout); script.remove(); reject(new Error('Draft cleanup unavailable')); };
        document.head.append(script);
      }).finally(function () { pendingDrafts = null; });
      return pendingDrafts;
    }
    function signOut(ownerId) {
      if (pendingLogout) return pendingLogout;
      var id = ownerId || user?.id;
      if (!id) return Promise.resolve();
      revision++;
      logoutButtons.forEach(function (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); setText(button, 'Abmelden…'); });
      groups.forEach(function (group) { group.querySelector('[data-account-menu-status]').hidden = true; });
      pendingLogout = (async function () {
        var clean = await draftCleaner();
        await request('logout', {});
        await clean(id);
        showUser(null);
        location.assign('/');
      })().catch(function (error) {
        groups.forEach(function (group) {
          var notice = group.querySelector('[data-account-menu-status]');
          setText(notice, 'Das hat leider nicht geklappt. Bitte versuche es erneut.');
          notice.hidden = false;
        });
        throw error;
      }).finally(function () {
        pendingLogout = null;
        logoutButtons.forEach(function (button) { button.disabled = false; button.setAttribute('aria-busy', 'false'); setText(button, 'Abmelden'); });
      });
      return pendingLogout;
    }
    groups.forEach(function (group) {
      group.querySelector('[data-account-menu-logout]').addEventListener('click', function () { void signOut().catch(function () {}); });
    });
    window.WolkenworteAccountMenu = { session: session, signOut: signOut };
    window.addEventListener('wolkenworte:accountchange', function (event) { revision++; showUser(event.detail?.user); });
    var refresh = function () { void session().catch(function () {}); };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', function (event) { if (event.persisted) refresh(); });
    groups.forEach(function (group) { group.closest('[data-ww-site-menu]').addEventListener('toggle', function (event) { if (event.target.open) refresh(); }); });
    // The account page already reads the session and publishes its result.
    if (document.getElementById('account-page')?.dataset.available !== 'true') refresh();
  }

  initializeAccountMenu();

  function setLabel(element, source) {
    if (window.WolkenworteI18n?.setAttribute) {
      window.WolkenworteI18n.setAttribute(element, 'aria-label', source);
    } else {
      element.setAttribute('aria-label', source);
    }
  }

  function updateHeaderState() {
    var scrolled = window.scrollY > 4;
    headers.forEach(function (header) {
      header.classList.toggle('scrolled', scrolled);
    });
  }

  updateHeaderState();
  window.addEventListener('scroll', updateHeaderState, { passive: true });

  document.querySelectorAll('[data-ww-site-menu]').forEach(function (menu) {
    var trigger = menu.querySelector('[data-ww-site-menu-trigger]');
    if (!trigger) return;

    menu.querySelectorAll('[data-ww-menu-picker]').forEach(function (picker) {
      var anchor = picker.querySelector('summary');
      var popup = picker.querySelector('[data-ww-menu-popup]');
      if (typeof popup?.showPopover !== 'function') return;
      popup.setAttribute('popover', 'manual');

      function placePopup() {
        if (!popup.matches(':popover-open')) return;
        var rect = anchor.getBoundingClientRect();
        var viewport = window.visualViewport;
        var left = (viewport?.offsetLeft || 0) + 8;
        var top = (viewport?.offsetTop || 0) + 8;
        var right = left + (viewport?.width || window.innerWidth) - 16;
        var bottom = top + (viewport?.height || window.innerHeight) - 16;
        var width = Math.min(Number(popup.dataset.popupWidth) || rect.width, right - left);
        var below = Math.max(0, bottom - rect.bottom - 8);
        var above = Math.max(0, rect.top - top - 8);
        popup.style.width = width + 'px';
        var opensAbove = below < popup.scrollHeight && above > below;
        popup.style.maxHeight = Math.min(bottom - top, opensAbove ? above : below) + 'px';
        popup.style.left = Math.max(left, Math.min(rect.right - width, right - width)) + 'px';
        var height = popup.getBoundingClientRect().height;
        popup.style.top = Math.max(top, Math.min(bottom - height, opensAbove ? rect.top - 8 - height : rect.bottom + 8)) + 'px';
      }

      picker.addEventListener('toggle', function () {
        if (picker.open && menu.open) {
          menu.querySelectorAll('[data-ww-menu-picker]').forEach(function (other) {
            if (other !== picker) other.open = false;
          });
          if (!popup.matches(':popover-open')) popup.showPopover();
          placePopup();
        } else if (popup.matches(':popover-open')) popup.hidePopover();
      });
      window.addEventListener('resize', placePopup);
      window.addEventListener('scroll', placePopup, true);
      window.visualViewport?.addEventListener('resize', placePopup);
      window.visualViewport?.addEventListener('scroll', placePopup);
    });

    function closeMenu(focus) {
      if (!menu.open) return;
      menu.querySelectorAll('details').forEach(function (picker) {
        picker.open = false;
      });
      menu.open = false;
      if (focus) trigger.focus();
    }

    menu.addEventListener('toggle', function () {
      setLabel(trigger, menu.open ? 'Menü schließen' : 'Menü öffnen');
      trigger.setAttribute('aria-expanded', String(menu.open));
      if (!menu.open) {
        menu.querySelectorAll('details').forEach(function (picker) { picker.open = false; });
      }
    });
    menu.querySelectorAll('a:not([data-language-code])').forEach(function (link) {
      link.addEventListener('click', function () { closeMenu(false); });
    });
    document.addEventListener('pointerdown', function (event) {
      if (menu.open && !menu.contains(event.target)) closeMenu(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || !menu.open || document.querySelector('dialog[open]')) return;
      if (event.defaultPrevented || menu.querySelector('details[open]')) return;
      event.preventDefault();
      closeMenu(true);
    });
  });
})();
