'use strict';

(function installWorkspace(root) {
  // Pure placement policy, shared by the browser and geometry regression tests.
  function placePanel(anchor, panel, viewport, gap = 8, inset = 12) {
    const width = Math.min(panel.width, viewport.width - inset * 2);
    const below = viewport.height - anchor.bottom - gap - inset;
    const above = anchor.top - gap - inset;
    const useAbove = below < Math.min(panel.height, 240) && above > below;
    const maxHeight = Math.max(0, Math.min(viewport.height - inset * 2, useAbove ? above : below));
    const height = Math.min(panel.height, maxHeight);
    return {
      left: Math.max(inset, Math.min(anchor.right - width, viewport.width - width - inset)),
      top: Math.max(inset, Math.min(useAbove ? anchor.top - gap - height : anchor.bottom + gap,
        viewport.height - height - inset)),
      maxHeight,
    };
  }

  class WolkenworteWorkspace {
    constructor(document) {
      this.document = document;
      this.media = root.matchMedia('(max-width: 940px)');
      this.selection = document.getElementById('editor-selection');
      this.desktopHost = document.getElementById('editor-desktop-inspector');
      this.compactHost = document.getElementById('editor-compact-inspector');
      this.toolbar = document.querySelector('.editor-toolbar');
      this.desktopToolbarHost = document.getElementById('workspace-tools');
      this.compactToolbarHost = document.getElementById('editor-compact-toolbar');
      this.resetPanel = document.getElementById('editor-reset-panel');
      this.resetButton = document.getElementById('editor-reset');
      document.getElementById('editor-reset-confirm').addEventListener('click', () => this.confirmReset());
      this.capabilities = {};
      this.active = null;
      for (const trigger of document.querySelectorAll('[data-panel-trigger]')) {
        trigger.addEventListener('click', () => this.toggleChooser(trigger));
      }
      for (const panel of document.querySelectorAll('.config-panel')) {
        for (const button of panel.querySelectorAll('[data-panel-close]')) {
          button.addEventListener('click', () => this.close());
        }
        panel.addEventListener('cancel', event => {
          event.preventDefault();
          this.close();
        });
        panel.addEventListener('close', () => {
          if (this.active?.panel === panel && !panel.open) this.finishClose();
        });
        panel.addEventListener('toggle', event => {
          if (this.active?.panel === panel && this.active.mode === 'popover' &&
              event.newState === 'closed' && !panel.matches(':popover-open')) this.finishClose(false);
        });
        // Native modal dialogs supply focus containment/inertness. Dismiss only
        // when both pointer endpoints are on the backdrop, not after a drag.
        let backdropStart = false;
        panel.addEventListener('pointerdown', event => {
          backdropStart = this.isBackdrop(event, panel);
        });
        panel.addEventListener('click', event => {
          if (backdropStart && this.isBackdrop(event, panel)) this.close();
          backdropStart = false;
        });
      }
      this.media.addEventListener('change', () => {
        const trigger = this.active?.trigger;
        const activeElement = this.document.activeElement;
        const selectionFocused = this.selection.contains(activeElement);
        const toolbarFocused = this.toolbar.contains(activeElement);
        this.close(false);
        this.mountInspector();
        if (trigger || selectionFocused) (!trigger || trigger.disabled || !trigger.getClientRects().length
          ? this.selection : trigger).focus({ preventScroll: true });
        else if (toolbarFocused && !activeElement.disabled && activeElement.getClientRects().length) {
          activeElement.focus({ preventScroll: true });
        }
      });
      const reposition = () => this.positionChooser();
      root.addEventListener('resize', reposition, { passive: true });
      root.addEventListener('scroll', reposition, { passive: true, capture: true });
      root.visualViewport?.addEventListener('resize', reposition, { passive: true });
      this.mountInspector();
    }

    mountInspector() {
      if (this.media.matches) {
        this.compactToolbarHost.append(this.toolbar);
        this.compactHost.append(this.selection);
      } else {
        this.desktopToolbarHost.insertBefore(this.toolbar, this.desktopHost);
        this.desktopHost.append(this.selection);
      }
    }

    isBackdrop(event, panel) {
      if (event.target !== panel) return false;
      const rect = panel.getBoundingClientRect();
      return event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom;
    }

    toggleChooser(trigger) {
      if (this.active?.trigger === trigger) return this.close();
      this.close();
      const panel = this.document.getElementById(trigger.dataset.panelTrigger);
      this.show(panel, trigger, !this.media.matches && typeof panel.showPopover === 'function');
    }

    show(panel, trigger, popover = false) {
      const mode = popover ? 'popover' : 'modal';
      this.active = { panel, trigger, mode };
      trigger.setAttribute('aria-expanded', 'true');
      panel.dataset.presentation = mode;
      if (popover) {
        panel.setAttribute('popover', 'auto');
        panel.removeAttribute('aria-modal');
        panel.showPopover();
        this.positionChooser();
      } else {
        panel.removeAttribute('popover');
        panel.setAttribute('aria-modal', 'true');
        panel.showModal();
      }
      // Do not autofocus text on simple selection or opening a chooser. This
      // keeps the mobile keyboard closed and the beginning of long lists visible.
      (panel.querySelector('[data-panel-initial-focus]') || panel.querySelector('h2')).focus({ preventScroll: true });
    }

    positionChooser() {
      if (this.active?.mode !== 'popover') return;
      const { panel, trigger } = this.active;
      const anchor = trigger.getBoundingClientRect();
      if (anchor.bottom <= 0 || anchor.top >= root.innerHeight) return this.close(false);
      const position = placePanel(anchor, { width: panel.offsetWidth, height: panel.scrollHeight }, {
        width: this.document.documentElement.clientWidth,
        height: root.visualViewport?.height || root.innerHeight,
      });
      panel.style.left = `${position.left}px`;
      panel.style.top = `${position.top}px`;
      panel.style.maxHeight = `${position.maxHeight}px`;
    }

    updateSelection(capabilities) {
      this.capabilities = capabilities;
    }

    openTextEditor() {
      if (!this.media.matches || !this.capabilities.text) return false;
      const input = this.document.getElementById('editor-text');
      if (!input || input.disabled) return false;
      input.focus({ preventScroll: true });
      input.select();
      return true;
    }

    closeChooser() {
      if (this.active?.panel !== this.resetPanel) this.close();
    }

    requestReset(command) {
      this.close();
      this.show(this.resetPanel, this.resetButton);
      this.active.resetCommand = command;
    }

    confirmReset() {
      const command = this.active?.resetCommand;
      if (!command) return;
      // Consume the confirmation before invoking the command: double-clicks
      // or a delayed event cannot apply it a second time.
      this.close();
      command();
    }

    close(restoreFocus = true) {
      if (!this.active) return;
      const { panel, mode } = this.active;
      // Let a focused field commit its native change/blur before closing.
      if (panel.contains(this.document.activeElement)) this.document.activeElement.blur();
      if (mode === 'popover') {
        if (panel.matches(':popover-open')) panel.hidePopover();
      } else if (panel.open) panel.close();
      this.finishClose(restoreFocus);
    }

    finishClose(restoreFocus = true) {
      if (!this.active) return;
      const { panel, trigger } = this.active;
      this.active = null;
      trigger.setAttribute('aria-expanded', 'false');
      panel.style.removeProperty('left');
      panel.style.removeProperty('top');
      panel.style.removeProperty('max-height');
      panel.removeAttribute('aria-modal');
      if (restoreFocus) (trigger.disabled || !trigger.getClientRects().length
        ? this.selection : trigger).focus({ preventScroll: true });
    }
  }

  root.WolkenworteWorkspace = WolkenworteWorkspace;
  if (typeof module === 'object' && module.exports) module.exports = { placePanel, WolkenworteWorkspace };
})(typeof window === 'object' ? window : globalThis);
