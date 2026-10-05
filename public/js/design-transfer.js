(function (root, factory) {
  const api = factory(
    typeof module === 'object' && module.exports ? require('./design-layout') : root.DesignLayout,
    typeof module === 'object' && module.exports ? require('./cloud-limits') : root.CloudLimits
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DesignTransfer = api;
}(typeof globalThis === 'object' ? globalThis : this, function (Layout, Limits) {
  'use strict';

  // One active design shares contents across product previews. Arrangements are
  // compact, bounded geometry records; uploaded pixels occur only in contents.
  const MAX_LAYOUTS = 32;
  const GEOMETRY = ['x', 'y', 'fontSize', 'size', 'width', 'height', 'angle', 'layoutFontSize', 'layoutFingerprint'];
  const copy = value => JSON.parse(JSON.stringify(value));
  const key = value => `${value.productKey}:${value.orientation || 'default'}`;
  const validArea = area => area && ['x', 'y', 'width', 'height'].every(name => Number.isFinite(area[name])) &&
    area.width > 0 && area.height > 0;

  function normalizeState(state) {
    if (state?.version !== 1 || !Array.isArray(state.surfaces) || state.surfaces.length > 2 ||
        !Array.isArray(state.layouts) || state.layouts.length > MAX_LAYOUTS ||
        state.surfaces.some(surface => !validArea(surface.area) || !Array.isArray(surface.design) ||
          surface.design.length > Limits.MAX_DESIGN_ELEMENTS) ||
        state.layouts.some(layout => !Array.isArray(layout.surfaces) || layout.surfaces.length > 2 ||
          layout.surfaces.some(design => !Array.isArray(design) || design.length > Limits.MAX_DESIGN_ELEMENTS))) {
      return { version: 1, surfaces: [], layouts: [] };
    }
    return copy(state);
  }

  function geometry(item) {
    const result = { id: item.id, type: item.type || 'text' };
    GEOMETRY.forEach(name => { if (item[name] !== undefined) result[name] = item[name]; });
    return result;
  }

  function capture(state, source) {
    const next = normalizeState(state);
    source.surfaces.forEach((surface, index) => {
      next.surfaces[index] = { area: copy(surface.area), design: copy(surface.design) };
    });
    next.layouts = next.layouts.filter(layout => key(layout) !== key(source));
    next.layouts.push({ productKey: source.productKey, orientation: source.orientation || 'default',
      surfaces: source.surfaces.map(surface => surface.design.map(geometry)) });
    next.layouts = next.layouts.slice(-MAX_LAYOUTS);
    return next;
  }

  function scaleDesign(surface, area) {
    const scale = Math.min(area.width / surface.area.width, area.height / surface.area.height);
    return surface.design.map(item => {
      const next = { ...item,
        x: area.x + area.width / 2 + (item.x - surface.area.x - surface.area.width / 2) * scale,
        y: area.y + area.height / 2 + (item.y - surface.area.y - surface.area.height / 2) * scale };
      if (item.type === 'image') {
        const imageScale = Math.max(scale, 24 / Math.min(item.width, item.height));
        next.width = item.width * imageScale;
        next.height = item.height * imageScale;
      } else if (item.type === 'icon') {
        next.size = Math.max(48, item.size * scale);
      } else {
        next.fontSize = Math.max(Limits.MIN_PRINT_FONT_SIZE, item.fontSize * scale);
        if (Number.isFinite(item.layoutFontSize)) next.layoutFontSize = item.layoutFontSize * scale;
      }
      delete next.layoutFingerprint;
      return next;
    });
  }

  function prepare(state, source, target, measurementContext, options = {}) {
    const next = capture(state, source);
    if (options.independent) next.layouts = [];
    const saved = next.layouts.find(layout => key(layout) === key(target));
    const designs = Object.fromEntries(target.surfaces.map((surface, index) => {
      // Single-sided products use the front. A hidden back stays in the draft;
      // the first visit to a two-sided product initializes its back from front.
      const contents = next.surfaces[index] || next.surfaces[0];
      let design = scaleDesign(contents, surface.area);
      if (saved?.surfaces[index]) {
        const positions = new Map(saved.surfaces[index].map(item => [item.id, item]));
        design = design.map(item => {
          const position = positions.get(item.id);
          if (!position || position.type !== (item.type || 'text')) return item;
          const restored = { ...item };
          GEOMETRY.forEach(name => {
            if (position[name] !== undefined) restored[name] = position[name];
          });
          return restored;
        });
      } else if (options.automatic) {
        design = Layout.optimizeDesign(design, [{ ...surface.area, optimize: true }],
          measurementContext, options);
      }
      design = Layout.fitDesignToSafeArea(design, surface.area, measurementContext, options).design;
      return [surface.key, design];
    }));
    return { state: next, designs, retainedBack: next.surfaces.length > target.surfaces.length };
  }

  return { capture, prepare, normalizeState, MAX_LAYOUTS };
}));
