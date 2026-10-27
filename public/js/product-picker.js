(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WolkenworteProductPicker = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  const group = p => p.catalogGroup || (p.previewType === 'mug' ? 'mug' : p.previewShape);
  const type = p => p.previewModel?.kind === 'case' ? 'phone-cases'
    : ['canvas', 'thin-canvas', 'framed-canvas'].includes(group(p)) ? 'canvas' : group(p);
  const labels = { 'phone-cases': 'Handyhüllen', canvas: 'Leinwand', 'framed-poster': 'Gerahmtes Poster' };
  const fields = {
    brand: 'Handymarke', model: 'Handymodell', case: 'Hüllentyp', finish: 'Oberfläche',
    style: 'Leinwandstil', size: 'Größe', volume: 'Fassungsvermögen', color: 'Farbe', frame: 'Rahmenfarbe',
  };
  const collator = new Intl.Collator('de', { numeric: true });
  let sequence = 0;

  // These labels describe the pinned public catalog, never a translated title.
  // Each row retains its original product object and fulfillment identity.
  function record(product) {
    const parts = (product.variantLabel || product.size.label).split(' · ');
    const kind = type(product), g = group(product), attributes = {};
    if (kind === 'phone-cases') {
      Object.assign(attributes, { brand: parts[0].startsWith('Samsung') ? 'Samsung' : 'Apple',
        model: parts[0], case: g === 'case-798' ? 'MagSafe' : 'Tough',
        finish: product.previewModel.finish === 'glossy' ? 'Glänzend' : 'Matt' });
    } else if (kind === 'canvas') {
      Object.assign(attributes, { style: g === 'thin-canvas' ? 'Dünn' : g === 'framed-canvas' ? 'Gerahmt' : 'Standard',
        size: product.size.label, frame: g === 'framed-canvas' ? parts.at(-1) : 'Ohne Rahmen' });
    } else if (g === 'framed-poster') Object.assign(attributes, { size: product.size.label, frame: parts.at(-1) });
    else if (product.familyKey === 'clothing') Object.assign(attributes, { size: parts[0], color: parts[1] });
    else if (product.size.volumeMl) Object.assign(attributes, { volume: `${product.size.volumeMl} ml`,
      ...(parts.length > 1 ? { color: parts.at(-1) } : {}) });
    else if (g === 'eco-tote') attributes.color = parts[0];
    else Object.assign(attributes, { size: parts[0], ...(parts.length > 1 ? { color: parts.at(-1) } : {}) });
    return { product, type: kind, attributes };
  }

  function types(products) {
    const groups = new Map();
    for (const product of products) {
      const key = type(product);
      if (!groups.has(key)) groups.set(key, { key, label: labels[key] || product.displayName, products: [] });
      groups.get(key).products.push(product);
    }
    return [...groups.values()];
  }

  function values(rows, key) {
    const result = [...new Set(rows.map(row => row.attributes[key]).filter(value => value != null))];
    return result.sort((a, b) => key === 'size' && /^(XS|S|M|L|XL|[2-5]XL)$/.test(a) && /^(XS|S|M|L|XL|[2-5]XL)$/.test(b)
      ? ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'].indexOf(a) - ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'].indexOf(b)
      : collator.compare(a, b));
  }

  function optionState(products, preferred = {}) {
    const rows = products.map(record), keys = Object.keys(rows[0]?.attributes || {});
    let candidates = rows;
    const selected = {}, options = [];
    for (const key of keys) {
      const available = values(candidates, key);
      const value = available.includes(preferred[key]) ? preferred[key] : available[0];
      selected[key] = value;
      options.push({ key, label: fields[key], values: available, value });
      candidates = candidates.filter(row => row.attributes[key] === value);
    }
    return { product: candidates[0]?.product, selected, options };
  }

  function create(host, { products, families = [], selectedKey, browse = false, i18n,
    photo, price, onConfirm, onPhoto, onNavigate = () => {}, onResize = () => {} }) {
    const document = host.ownerDocument;
    const tr = (text, params) => i18n.t(text, params);
    const node = (tag, className, parent, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text != null) element.textContent = text;
      parent?.append(element);
      return element;
    };
    const original = products.find(p => p.key === selectedKey) || products[0];
    const remembered = new Map([[type(original), record(original).attributes]]);
    let stage = browse ? 'families' : 'options', familyKey = original.familyKey;
    let productType = type(original), state, content, actions;
    host.classList.add('product-picker');
    host.removeAttribute('role');

    function navigate(next, { focus = true } = {}) {
      stage = next;
      render();
      if (focus) (content.querySelector('button') || content).focus({ preventScroll: true });
    }

    function back() {
      if (!browse || stage === 'families') return false;
      navigate(stage === 'options' && types(products.filter(p => p.familyKey === familyKey)).length > 1 ? 'types' : 'families');
      return true;
    }

    function showType(entry) {
      productType = entry.key;
      if (!remembered.has(productType)) remembered.set(productType, record(entry.products[0]).attributes);
      navigate('options');
    }

    function choice(label, representative, callback) {
      const button = node('button', 'product-picker-choice', content);
      button.type = 'button';
      const image = node('img', '', button); image.alt = ''; image.src = photo(representative); image.loading = 'lazy';
      node('span', '', button, tr(label));
      node('span', 'product-picker-chevron', button, '›').setAttribute('aria-hidden', 'true');
      button.addEventListener('click', callback);
    }

    function applyOption(key, value) {
      remembered.set(productType, { ...state.selected, [key]: value });
      render();
      host.querySelector(`[data-option-key="${key}"] button[aria-pressed="true"], [data-option-key="${key}"] .product-picker-select`)?.focus({ preventScroll: true });
    }

    function renderField(field) {
      if (field.values.length < 2) return;
      const box = node('fieldset', 'product-picker-field', content);
      box.dataset.optionKey = field.key;
      node('legend', '', box, tr(field.label));
      if (field.values.length <= 8) {
        const options = node('div', 'product-picker-buttons', box);
        for (const value of field.values) {
          const button = node('button', 'product-picker-option', options, tr(value));
          button.type = 'button'; button.dataset.value = value;
          button.setAttribute('aria-pressed', String(value === field.value));
          button.addEventListener('click', () => applyOption(field.key, value));
        }
        return;
      }
      const id = `product-picker-options-${++sequence}`;
      const toggle = node('button', 'product-picker-select', box, tr(field.value));
      toggle.type = 'button'; toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', id);
      const popup = node('div', 'product-picker-search', box); popup.hidden = true;
      const input = node('input', '', popup); input.type = 'search'; input.autocomplete = 'off';
      input.placeholder = tr('Option suchen…');
      input.setAttribute('aria-label', tr('{{item}} suchen', { item: tr(field.label) }));
      input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', id);
      const list = node('div', 'product-picker-results', popup); list.id = id; list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', tr(field.label));
      const normalized = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
        .replace(/,/g, '.').replace(/×/g, 'x').replace(/\s+/g, '');
      let active = -1;
      function highlight(index) {
        const options = [...list.children].filter(e => e.matches('button'));
        if (!options.length) return;
        active = (index + options.length) % options.length;
        options.forEach((button, i) => button.classList.toggle('is-active', i === active));
        input.setAttribute('aria-activedescendant', options[active].id);
        options[active].scrollIntoView?.({ block: 'nearest' });
      }
      function results() {
        list.replaceChildren(); active = -1; input.removeAttribute('aria-activedescendant');
        for (const value of field.values.filter(v => normalized(tr(v)).includes(normalized(input.value)))) {
          const option = node('button', 'product-picker-result', list, tr(value));
          option.type = 'button'; option.tabIndex = -1; option.id = `${id}-${list.children.length}`;
          option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(value === field.value));
          option.addEventListener('click', () => applyOption(field.key, value));
        }
        if (!list.children.length) node('p', '', list, tr('Keine passenden Optionen.'));
        onResize();
      }
      toggle.addEventListener('click', () => {
        popup.hidden = !popup.hidden; toggle.setAttribute('aria-expanded', String(!popup.hidden));
        if (!popup.hidden) { results(); input.focus({ preventScroll: true }); }
        else onResize();
      });
      input.addEventListener('input', results);
      popup.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); popup.hidden = true;
          toggle.setAttribute('aria-expanded', 'false'); toggle.focus({ preventScroll: true });
          onResize();
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); highlight(event.key === 'Home' ? 0 : event.key === 'End' ? list.children.length - 1
            : active + (event.key === 'ArrowUp' ? -1 : 1));
        } else if (event.key === 'Enter' && active >= 0) {
          event.preventDefault(); list.children[active]?.click();
        }
      });
    }

    function render() {
      const scrollTop = stage === 'options' ? content?.scrollTop || 0 : 0;
      host.replaceChildren();
      content = node('div', 'product-picker-content', host); content.tabIndex = -1;
      const familyProducts = products.filter(p => p.familyKey === familyKey);
      const family = families.find(f => f.key === familyKey);
      const entries = types(familyProducts);
      let title = 'Produkt für dieses Design ändern';
      if (stage === 'families') {
        for (const entry of families.filter(f => products.some(p => p.familyKey === f.key))) {
          const candidates = products.filter(p => p.familyKey === entry.key);
          choice(entry.key === 'posters' ? 'Wandbilder' : entry.label,
            candidates.find(p => p.key === original.key) || candidates[0], () => {
              familyKey = entry.key;
              const available = types(candidates);
              if (available.length === 1) showType(available[0]); else navigate('types');
            });
        }
      } else if (stage === 'types') {
        title = familyKey === 'posters' ? 'Wandbilder' : family?.label || '';
        for (const entry of entries) choice(entry.label,
          entry.products.find(p => p.key === original.key) || entry.products[0], () => showType(entry));
      } else {
        const candidates = products.filter(p => type(p) === productType && (!browse || p.familyKey === familyKey));
        state = optionState(candidates, remembered.get(productType));
        remembered.set(productType, state.selected);
        title = labels[productType] || state.product.displayName;
        if (browse) node('p', 'product-picker-path', content,
          `${tr(familyKey === 'posters' ? 'Wandbilder' : family?.label || '')} / ${tr(title)}`);
        for (const field of state.options) renderField(field);
        actions = node('div', 'product-picker-actions', host);
        const summary = node('div', 'product-picker-summary', actions);
        const imageButton = node('button', 'product-picker-photo', summary); imageButton.type = 'button';
        imageButton.setAttribute('aria-label', tr('Details & Vorschau'));
        const image = node('img', '', imageButton); image.alt = ''; image.src = photo(state.product);
        imageButton.addEventListener('click', () => onPhoto?.(state.product, imageButton));
        const copy = node('div', '', summary);
        node('strong', '', copy, tr(state.product.variantLabel || state.product.size.label));
        node('span', '', copy, price(state.product));
        const apply = node('button', 'product-picker-apply', actions, tr('Produkt übernehmen'));
        apply.type = 'button'; apply.addEventListener('click', () => onConfirm(state.product));
        content.scrollTop = scrollTop;
      }
      host.dataset.pickerStage = stage;
      onNavigate({ title, canBack: browse && stage !== 'families', stage });
    }
    render();
    return { back, home: () => navigate('families', { focus: false }),
      get selected() { return state?.product; }, get stage() { return stage; } };
  }
  return { create, record, types, optionState, type };
});
