'use strict';

(function installToolbar(root) {
  function tooltipPosition(anchor, tip, viewport) {
    const inset = 8;
    const gap = 8;
    const below = anchor.bottom + gap;
    return {
      left: Math.max(inset, Math.min(anchor.left + (anchor.width - tip.width) / 2,
        viewport.width - tip.width - inset)),
      top: Math.max(inset, below + tip.height <= viewport.height - inset
        ? below : anchor.top - gap - tip.height),
    };
  }

  class WolkenworteToolbar {
    constructor(document) {
      this.document = document;
      this.tooltip = document.getElementById('editor-toolbar-tooltip');
      this.owner = null;
      this.timer = null;
      for (const button of document.querySelectorAll('[data-editor-tooltip]')) {
        button.addEventListener('pointerenter', event => {
          if (event.pointerType === 'touch') return;
          this.cancelTimer();
          this.timer = root.setTimeout(() => this.show(button), 350);
        });
        button.addEventListener('pointerleave', () => this.scheduleHide());
        button.addEventListener('focus', () => {
          if (button.matches(':focus-visible')) this.show(button);
        });
        button.addEventListener('blur', () => this.scheduleHide());
        button.addEventListener('pointerdown', () => this.hide());
        button.addEventListener('click', () => this.hide());
      }
      // Hoverable and persistent, including while crossing the small gap.
      this.tooltip.addEventListener('pointerenter', () => this.cancelTimer());
      this.tooltip.addEventListener('pointerleave', () => this.scheduleHide());
      document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !this.owner) return;
        this.hide();
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
      document.addEventListener('pointerdown', event => {
        if (!this.tooltip.contains(event.target)) this.hide();
      }, true);
      root.addEventListener('scroll', () => this.hide(), { passive: true, capture: true });
      root.addEventListener('resize', () => this.hide(), { passive: true });
      // Native dialogs can also close without a pointer event (Escape, resize).
      for (const panel of document.querySelectorAll('dialog')) panel.addEventListener('close', () => this.hide());
    }

    cancelTimer() {
      root.clearTimeout(this.timer);
      this.timer = null;
    }

    scheduleHide() {
      this.cancelTimer();
      this.timer = root.setTimeout(() => this.hide(), 120);
    }

    show(button) {
      this.hide();
      if (button.disabled || !button.getClientRects().length) return;
      this.owner = button;
      // Use the already-localized accessible name, not a second string catalog.
      // It names the button; duplicating it in aria-describedby would announce
      // the same text twice to assistive technology.
      this.tooltip.textContent = button.getAttribute('aria-label');
      (button.closest('dialog') || this.document.body).append(this.tooltip);
      this.tooltip.hidden = false;
      if (typeof this.tooltip.showPopover === 'function') {
        this.tooltip.setAttribute('popover', 'manual');
        this.tooltip.showPopover();
      }
      const position = tooltipPosition(button.getBoundingClientRect(), this.tooltip.getBoundingClientRect(), {
        width: this.document.documentElement.clientWidth,
        height: root.innerHeight,
      });
      this.tooltip.style.left = `${position.left}px`;
      this.tooltip.style.top = `${position.top}px`;
    }

    hide() {
      this.cancelTimer();
      if (typeof this.tooltip.hidePopover === 'function' && this.tooltip.matches(':popover-open')) this.tooltip.hidePopover();
      this.tooltip.hidden = true;
      this.owner = null;
    }
  }

  root.WolkenworteToolbar = WolkenworteToolbar;
  if (typeof module === 'object' && module.exports) module.exports = { tooltipPosition, WolkenworteToolbar };
})(typeof window === 'object' ? window : globalThis);
