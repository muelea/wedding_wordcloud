(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./emoji-catalog'), require('./cloud-limits'));
  } else root.ContributionInput = factory(root.WolkenworteEmoji, root.CloudLimits);
})(typeof self !== 'undefined' ? self : this, function (Emoji, Limits) {
  'use strict';

  const maximum = Limits.MAX_WORD_LENGTH;
  const length = text => Emoji.graphemeLength(text);

  // Preserve text on both sides of a replacement, including a paste at the
  // beginning or middle of a full field. Never split a combined emoji.
  function replace(value, start, end, inserted) {
    const prefix = value.slice(0, start);
    const suffix = value.slice(end);
    let accepted = inserted;
    if (length(prefix + inserted + suffix) > maximum) {
      accepted = '';
      for (const character of Emoji.graphemes(inserted)) {
        if (length(prefix + accepted + character + suffix) > maximum) break;
        accepted += character;
      }
    }
    return { value: prefix + accepted + suffix, caret: prefix.length + accepted.length };
  }

  function bind(input, { onChange = () => {} } = {}) {
    let composing = false;
    let before = null;

    function refresh() {
      const count = length(input.value);
      onChange(count, maximum);
      before = null;
      return count;
    }

    function write(result) {
      input.value = result.value;
      input.setSelectionRange(result.caret, result.caret);
    }

    function enforce() {
      if (composing) return false;
      if (length(input.value) > maximum) {
        const prefix = before?.value.slice(0, before.start);
        const suffix = before?.value.slice(before.end);
        if (before && input.value.startsWith(prefix) && input.value.endsWith(suffix)) {
          const inserted = input.value.slice(prefix.length, input.value.length - suffix.length);
          write(replace(before.value, before.start, before.end, inserted));
        } else {
          const caret = input.selectionStart ?? input.value.length;
          input.value = Emoji.truncateGraphemes(input.value, maximum);
          input.setSelectionRange(Math.min(caret, input.value.length), Math.min(caret, input.value.length));
        }
      }
      refresh();
      return true;
    }

    function insert(text) {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      write(replace(input.value, start, end, String(text)));
      before = null;
      const EventType = input.ownerDocument.defaultView.Event;
      input.dispatchEvent(new EventType('input', { bubbles: true }));
    }

    input.addEventListener('beforeinput', event => {
      if (composing || event.isComposing) return;
      before = { value: input.value, start: input.selectionStart ?? input.value.length,
        end: input.selectionEnd ?? input.value.length };
      if (!event.cancelable || !event.inputType?.startsWith('insert') || event.data == null) return;
      if (length(input.value.slice(0, before.start) + event.data + input.value.slice(before.end)) <= maximum) return;
      event.preventDefault();
      insert(event.data);
    });
    input.addEventListener('paste', event => {
      if (composing || !event.clipboardData) return;
      event.preventDefault();
      insert(event.clipboardData.getData('text/plain'));
    });
    input.addEventListener('input', event => {
      if (!composing && !event.isComposing) enforce();
    });
    input.addEventListener('compositionstart', () => {
      before = { value: input.value, start: input.selectionStart ?? input.value.length,
        end: input.selectionEnd ?? input.value.length };
      composing = true;
    });
    input.addEventListener('compositionend', () => {
      composing = false;
      enforce();
    });
    enforce();
    return { insert, refresh, enforce };
  }

  return { bind, replace };
});
