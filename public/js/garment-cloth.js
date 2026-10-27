(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GarmentCloth = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const STEP = 1 / 60;
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = t => t * t * (3 - 2 * t);

  // Pattern coordinates and print placement are centimetres. The hanging
  // silhouette is tailored to the three supplier garments, rather than using
  // a scaled cylinder for every body, sleeve and neckline.
  function pattern(model) {
    const { width: w, height: h, sleeve } = model;
    const tee = model.garment === 't-shirt', hoodie = model.garment === 'hoodie';
    const cols = 32, lower = 24, upper = 12, rows = lower + upper;
    const depth = w * (tee ? .105 : .115), neck = w * (hoodie ? .165 : .158);
    const shoulder = w * (tee ? .389 : .42), bandHeight = tee ? 1.5 : 7;
    const vertices = [], parts = [], lookup = new Map(), pins = new Set();
    const neckFront = [], neckBack = [], hemFront = [], hemBack = [], cuffs = [];
    const hoodNecks = [], hoodRim = [], hoodCenter = [];
    const point = position => {
      const key = position.map(v => Math.round(v * 10000)).join(',');
      if (lookup.has(key)) return lookup.get(key);
      const id = vertices.length / 3; vertices.push(...position); lookup.set(key, id); return id;
    };
    const part = (name, material) => { const p = { name, material, ids: [], uv: [], triangles: [] }; parts.push(p); return p; };
    function grid(p, nx, ny, sample, uv, reverse = false) {
      p.columns = nx; p.rows = ny;
      for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) {
        const pos = sample(x / nx, y / ny, x, y);
        p.ids.push(point(pos)); p.uv.push(...uv(pos, x / nx, y / ny));
      }
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const a = y * (nx + 1) + x, b = a + 1, c = a + nx + 1, d = c + 1;
        p.triangles.push(...(reverse ? [a, b, c, b, d, c] : [a, c, b, b, c, d]));
      }
    }
    function lowerY(t) {
      const bandRows = 3 / lower;
      return -h / 2 + (t < bandRows ? bandHeight * t / bandRows :
        bandHeight + (h * .725 - bandHeight) * (t - bandRows) / (1 - bandRows));
    }
    function bodyHalf(v) {
      const t = v * rows / lower;
      if (t > 1) return mix(w * .403, shoulder, smooth((v * rows - lower) / upper));
      const waist = tee ? .002 : .018 * (1 - smooth(Math.min(1, t * 8)));
      return w * (.403 + .009 * Math.sin(t * Math.PI) - waist);
    }
    function body(u, v, side) {
      const a = Math.abs(u), top = h / 2;
      const armpit = h * .225;
      const neckCurve = Math.max(0, 1 - (u * shoulder / neck) ** 2);
      const shoulderDrop = h * .071 * Math.max(0, (a * shoulder - neck) / (shoulder - neck));
      const topY = top - shoulderDrop - neckCurve * h * (side > 0 ? .073 : .014);
      const upperT = Math.max(0, (v * rows - lower) / upper);
      let y = v <= lower / rows ? lowerY(v * rows / lower) : mix(armpit, topY, upperT);
      const aboveBand = smooth(Math.min(1, Math.max(0, (y + top - bandHeight) / 5)));
      // A hem is supported by its sewn band. It does not undulate like a
      // curtain; the broader vertical folds end softly just above the rib.
      y += (1 + Math.sin(u * 5 + .8)) * .065 * (1 - a * a) * Math.exp(-v * 12) * (tee ? 1 : 0);
      const x = u * bodyHalf(v), edge = Math.max(0, 1 - a ** 6);
      let z = depth * Math.sqrt(edge) * (.91 + .09 * Math.sin(v * Math.PI));
      if (upperT > 0) {
        z = mix(z, neckCurve * depth * .73, smooth(upperT) ** 3);
        z += Math.sin(upperT * Math.PI) * depth * .74 * a ** 8;
      }
      const free = (1 - a * a), low = Math.exp(-(((v - .27) / .32) ** 2));
      let folds = (.80 * Math.sin(u * 11 + v * 2.8 + .6) + .16 * Math.sin(u * 22 - v * 4)) * free * low;
      folds += 2.0 * Math.sin(a * 24 - v * 13) * Math.exp(-(((v - .69 - a * .13) / .12) ** 2)) * a * a * free;
      folds += .2 * Math.sin(u * 18 + v * 28) * Math.exp(-(((v - .2) / .13) ** 2)) * a ** 4 * free;
      z += folds * aboveBand * (1 - smooth(upperT)) * (tee ? 1.1 : .8);
      // Slightly flattened ribbing and a minute seam welt give a tangible
      // change in thickness without a conspicuous cord around the bottom.
      z -= (tee ? .06 : .18) * (1 - aboveBand) * free;
      return [x, y, z * side];
    }
    function bodyAt(x, y, side) {
      let v = (y + h / 2) / h;
      for (let n = 0; n < 8; n++) {
        const u = x / bodyHalf(v), sample = body(u, v, side);
        const delta = .0001, next = body(x / bodyHalf(v + delta), v + delta, side);
        v += (y - sample[1]) / Math.max(1, (next[1] - sample[1]) / delta);
      }
      if (v < -.001 || v > 1.001 || Math.abs(x) > bodyHalf(v)) return null;
      return body(x / bodyHalf(v), v, side);
    }
    for (const side of [1, -1]) {
      const p = part(side > 0 ? 'garment-front' : 'garment-back', side > 0 ? 'print' : 'fabric');
      grid(p, cols, rows, (u, v) => body(u * 2 - 1, v, side), pos => [
        pos[0] / model.printWidth + .5,
        1 - (h / 2 - model.printTop - pos[1]) / model.printHeight,
      ], side > 0);
      const neckLine = side > 0 ? neckFront : neckBack, hem = side > 0 ? hemFront : hemBack;
      for (let x = 0; x <= cols; x++) {
        const id = p.ids[rows * (cols + 1) + x]; neckLine.push(id); hem.push(p.ids[x]);
        if (Math.abs(vertices[id * 3]) > neck) pins.add(id);
      }
    }
    for (const sign of [-1, 1]) {
      const ring = upper * 2, segments = tee ? 14 : 24;
      const angle = (tee ? 25 : 7) * Math.PI / 180;
      const axis = [sign * Math.sin(angle), -Math.cos(angle), 0], radial = [sign * Math.cos(angle), Math.sin(angle), 0];
      const center = [sign * w * (tee ? .384 : .391), h * .312, 0];
      const length = sleeve * (tee ? .85 : .92), radius = w * (tee ? .122 : .064);
      const p = part(`garment-sleeve-${sign}`, 'fabric');
      grid(p, ring, segments, (u, t) => {
        const k = Math.round(u * ring), front = k <= upper;
        const v = front ? 1 - k / upper : (k - upper) / upper;
        const base = body(sign, (lower + v * upper) / rows, front ? 1 : -1);
        if (!t) return base;
        const theta = u * Math.PI * 2;
        const cuffT = tee ? 1 : .875;
        const along = tee ? t * length : t < cuffT ? (length - 6.5) * t / cuffT : length - 6.5 + 6.5 * (t - cuffT) / (1 - cuffT);
        const r = tee ? mix(h * .102, radius, smooth(t)) :
          t < cuffT ? mix(h * .105, radius * 1.16, smooth(t / cuffT)) : mix(radius * 1.02, radius, (t - cuffT) / (1 - cuffT));
        const elbow = tee ? .05 : Math.exp(-(((t - .67) / .2) ** 2));
        const wrinkle = (.35 * Math.sin(t * 38 + theta * 1.8) + .15 * Math.sin(t * 66 - theta)) * elbow;
        const c = center.map((value, i) => value + axis[i] * along);
        // A small bent elbow and soft longitudinal fold prevent pipe-like
        // sleeves. Keep the cuff itself quiet and distinctly cylindrical.
        c[2] += (tee ? .3 : .8) * Math.sin(t * Math.PI);
        const shape = c.map((value, i) => value + radial[i] * Math.cos(theta) * (r + wrinkle) +
          (i === 2 ? Math.sin(theta) * (r * .79 + wrinkle) : 0));
        const blend = smooth(Math.min(1, t / (tee ? .30 : .43)));
        const cap = Math.sin(Math.min(1, t / .5) * Math.PI) * Math.max(0, Math.cos(theta));
        return shape.map((value, i) => mix(base[i] + axis[i] * along, value, blend) +
          (i === 0 ? sign * w * .028 * cap : i === 1 ? h * .018 * cap : 0));
      }, (_, u, v) => [u * w * .43, v * length], sign > 0);
      cuffs.push(p.ids.slice(-ring - 1));
    }
    if (hoodie) {
      // The reference is photographed with a raised, relaxed hood. Its open
      // mouth slopes from the high rounded back to the crossed throat. Two
      // genuinely separated layers reveal a shaded lining through the opening.
      const hoodCols = 48, hoodRows = 18;
      for (const inside of [false, true]) {
        const p = part(inside ? 'garment-hood-lining' : 'garment-hood', 'fabric'); p.shade = [];
        grid(p, hoodCols, hoodRows, (u, v) => {
          const theta = u * Math.PI * 2, cosine = Math.cos(theta), front = Math.max(0, cosine);
          const baseX = neck * Math.sin(theta), baseZ = depth * .73 * cosine * Math.abs(cosine);
          const baseY = h / 2 - h * cosine * cosine * (cosine >= 0 ? .094 : .014);
          const rimX = w * .233 * Math.sin(theta);
          const rimY = h / 2 + h * (cosine >= 0 ? -.040 + .090 * Math.abs(Math.sin(theta)) : .050 - .090 * cosine);
          const rimZ = depth * (1.3 * cosine - .10);
          const t = 1 - v, back = Math.max(0, -cosine), cheek = Math.sin(theta) ** 2;
          let x = mix(baseX, rimX, smooth(v)) + Math.sin(theta) * Math.sin(v * Math.PI) * w * .045;
          // Bezier crown: the outside rounds over before turning into the
          // mouth. A linear cone produces the rigid pointed collar silhouette.
          let y = t ** 3 * baseY + 3 * t * t * v * (baseY - h * (.10 * back + .035 * cheek)) +
            3 * t * v * v * (rimY + h * .024 * back) + v ** 3 * rimY;
          let z = t ** 3 * baseZ + 3 * t * t * v * (baseZ - w * .16 * back + w * .05 * cheek) +
            3 * t * v * v * (rimZ - w * .13 * back + w * .025 * cheek) + v ** 3 * rimZ;
          const fold = Math.sin(v * Math.PI);
          z += fold * (1.2 * Math.sin(theta * 3 + v * 5) + .45 * Math.sin(theta * 7 - v * 4));
          z += back * fold * Math.exp(-((Math.sin(theta) / .23) ** 2)) * 1.1;
          y += fold * front * .65 * Math.sin(theta * 4 + v * 3);
          z += fold * front * .75 * Math.sin(theta * 5 + v * 2);
          // Turned, softly irregular lip, with subdued puckering at the crown.
          y += Math.sin(theta * 9 + .8) * .14 * v ** 4;
          z += Math.sin(theta * 11) * .10 * v ** 5;
          if (inside) { x -= Math.sin(theta) * .32; z -= cosine * .32; y -= .10; }
          const support = bodyAt(x, y, z >= 0 ? 1 : -1);
          if (support) z = z >= 0 ? Math.max(z, support[2] + (inside ? .42 : .66)) : Math.min(z, support[2] - (inside ? .42 : .66));
          const centerCrease = Math.exp(-(((theta - Math.PI) / .075) ** 2)) * fold;
          const sideCreases = Math.exp(-(((theta - 2.2) / .20) ** 2)) + Math.exp(-(((theta - 4.15) / .18) ** 2));
          const cavity = inside ? .025 + .10 * (1 - v) + .14 * centerCrease + .075 * sideCreases * fold : .025 * fold + .045 * front * fold * (1 + Math.sin(theta * 3));
          p.shade.push(1 - cavity);
          return [x, y, z];
        }, (_, u, v) => [u * w * .9, v * h * .22], inside);
        hoodNecks.push(p.ids.slice(0, hoodCols + 1));
        if (!inside) {
          hoodRim.push(...p.ids.slice(-hoodCols - 1));
          for (let row = 0; row <= hoodRows; row++) hoodCenter.push(p.ids[row * (hoodCols + 1) + hoodCols / 2]);
        }
      }
      const p = part('garment-kangaroo-pocket', 'fabric'); p.shade = [];
      grid(p, 24, 14, (u, v) => {
        const top = -h * .04, bottom = -h / 2 + bandHeight + .35;
        // Wide lower corners, a horizontal top edge and diagonal hand entries.
        const half = w * (.327 - .088 * smooth(v));
        const x = (u * 2 - 1) * half, y = mix(bottom, top, v);
        const edge = Math.sin(u * Math.PI), lift = .16 + edge * Math.sin(v * Math.PI) * .33;
        const opening = (1 - edge) ** 5 * Math.sin(v * Math.PI) * .25;
        const z = bodyAt(x, y, 1)[2] + lift + opening;
        p.shade.push(1 - (1 - edge) ** 10 * .075);
        return [x, y, z];
      }, (_, u, v) => [u * w * .65, v * h * .32], true);
    }
    const stitches = [];
    function stitch(id, candidates) {
      let best = -1, distance = Infinity;
      for (const candidate of candidates) {
        const d = [0, 1, 2].reduce((sum, k) => sum + (vertices[id * 3 + k] - vertices[candidate * 3 + k]) ** 2, 0);
        if (d < distance) { best = candidate; distance = d; }
      }
      if (best >= 0 && best !== id) stitches.push([id, best]);
    }
    if (hoodie) {
      for (const ids of hoodNecks) for (const id of ids) stitch(id, [...neckFront, ...neckBack]);
      const p = parts.find(p => p.name === 'garment-kangaroo-pocket');
      for (let y = 0; y <= p.rows; y++) for (let x = 0; x <= p.columns; x++) {
        if (!y || y === p.rows || (y <= 2 && (!x || x === p.columns))) stitch(p.ids[y * (p.columns + 1) + x], parts[0].ids);
      }
    }
    return { rest: new Float32Array(vertices), parts, stitches, pins: [...pins], neckFront, neckBack, hemFront, hemBack, cuffs, hoodRim, hoodCenter, bandHeight };
  }

  function simulate(pattern, model) {
    const rest = Float32Array.from(pattern.rest, p => p / 100), positions = rest.slice(), previous = rest.slice();
    const count = rest.length / 3, pinned = new Set(pattern.pins);
    const heavy = model.fabricWeight >= 300;
    let endpoints, lengths, stiffness;
    // Gallery cards usually never get pulled. Build the constraint graph only
    // on the first deliberate grab, not while scrolling past static previews.
    function prepare() {
      if (lengths) return;
      const edges = new Map(), opposites = new Map();
      const edge = (a, b, bend = false) => {
        if (a === b) return;
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (!edges.has(key)) edges.set(key, { a, b, length: Math.hypot(...[0, 1, 2].map(k => rest[a * 3 + k] - rest[b * 3 + k])), bend });
      };
      for (const p of pattern.parts) for (let t = 0; t < p.triangles.length; t += 3) {
        const ids = p.triangles.slice(t, t + 3).map(i => p.ids[i]);
        for (let n = 0; n < 3; n++) {
          const a = ids[n], b = ids[(n + 1) % 3], other = ids[(n + 2) % 3]; edge(a, b);
          const key = a < b ? `${a}:${b}` : `${b}:${a}`;
          if (opposites.has(key)) edge(opposites.get(key), other, true); else opposites.set(key, other);
        }
      }
      pattern.stitches.forEach(([a, b]) => edge(a, b));
      const links = [...edges.values()].filter(e => e.length > 1e-7);
      endpoints = new Uint32Array(links.length * 2); lengths = new Float32Array(links.length); stiffness = new Float32Array(links.length);
      links.forEach((e, i) => { endpoints[i * 2] = e.a * 3; endpoints[i * 2 + 1] = e.b * 3; lengths[i] = e.length; stiffness[i] = e.bend ? heavy ? .65 : .3 : .96; });
    }
    const weights = new Uint8Array(count).fill(1); pattern.pins.forEach(id => { weights[id] = 0; });
    const targets = [0, 0, 0];
    let grabbed = -1, awake = false, quiet = 0, age = 0, accumulator = 0;
    function wake() { awake = true; quiet = 0; age = 0; }
    function step() {
      for (let i = 0; i < count; i++) {
        if (pinned.has(i) || i === grabbed) continue;
        for (let k = 0; k < 3; k++) {
          const p = i * 3 + k, value = positions[p];
          const velocity = (value - previous[p]) * (heavy ? .94 : .96);
          previous[p] = value;
          // The supported hanging shape is the equilibrium state. Gentle
          // support preserves the empty garment's volume while local pulls
          // still propagate through its stitched panels and sleeves.
          positions[p] = value + velocity + (rest[p] - value) * (heavy ? .02 : .012);
        }
      }
      for (let pass = 0; pass < 4; pass++) {
        if (grabbed >= 0) for (let k = 0; k < 3; k++) positions[grabbed * 3 + k] = targets[k];
        for (let i = 0; i < lengths.length; i++) {
          const p = endpoints[i * 2], q = endpoints[i * 2 + 1];
          const wa = weights[p / 3], wb = weights[q / 3];
          if (!(wa + wb)) continue;
          const dx = positions[p] - positions[q], dy = positions[p + 1] - positions[q + 1], dz = positions[p + 2] - positions[q + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz); if (d < 1e-8) continue;
          const correction = (d - lengths[i]) / d / (wa + wb) * stiffness[i];
          positions[p] -= dx * correction * wa; positions[q] += dx * correction * wb;
          positions[p + 1] -= dy * correction * wa; positions[q + 1] += dy * correction * wb;
          positions[p + 2] -= dz * correction * wa; positions[q + 2] += dz * correction * wb;
        }
      }

      // Limit displaced cloth to its local shell side to keep the front from
      // passing through the unprinted back during an inward pointer pull.
      for (let i = 0; i < count; i++) {
        const p = i * 3;
        if (pinned.has(i)) for (let k = 0; k < 3; k++) positions[p + k] = rest[p + k];
        if (i === grabbed) continue;
        const sign = Math.sign(rest[p + 2]);
        if (Math.abs(rest[p + 2]) > .01 && sign * positions[p + 2] < .002) positions[p + 2] = sign * .002;
      }
      if (grabbed >= 0) for (let k = 0; k < 3; k++) previous[grabbed * 3 + k] = positions[grabbed * 3 + k];
    }
    function move(point) {
      if (grabbed < 0 || !point.every(Number.isFinite)) return;
      const p = grabbed * 3, delta = point.map((v, k) => v / 100 - rest[p + k]);
      const max = Math.min(.24, model.height / 100 * .28), length = Math.hypot(...delta), factor = length > max ? max / length : 1;
      for (let k = 0; k < 3; k++) targets[k] = rest[p + k] + delta[k] * factor;
      if (Math.abs(rest[p + 2]) > .01) targets[2] = Math.sign(rest[p + 2]) * Math.max(.003, Math.sign(rest[p + 2]) * targets[2]);
      wake();
    }
    function release() { if (grabbed < 0) return; weights[grabbed] = 1; grabbed = -1; wake(); }
    function sleep() { awake = false; accumulator = 0; previous.set(positions); }
    return { positions, rest, pins: pattern.pins, release, move, sleep,
      get active() { return awake; }, get grabbed() { return grabbed; },
      grab(id) {
        if (!Number.isInteger(id) || id < 0 || id >= count || pinned.has(id)) return false;
        prepare();
        if (grabbed >= 0) weights[grabbed] = 1;
        grabbed = id; weights[id] = 0; move(Array.from(positions.subarray(id * 3, id * 3 + 3), v => v * 100)); return true;
      },
      advance(elapsed) {
        if (!awake || !Number.isFinite(elapsed) || elapsed <= 0) return false;
        accumulator = Math.min(accumulator + elapsed, STEP * 4); let changed = false;
        while (accumulator >= STEP) {
          step(); changed = true; accumulator -= STEP; age += STEP;
          if (grabbed < 0) {
            let energy = 0; for (let p = 0; p < positions.length; p++) energy += (positions[p] - previous[p]) ** 2;
            quiet = energy / count < 2e-10 ? quiet + STEP : 0;
            if (quiet > .5 || age > 5) { sleep(); break; }
          }
        }
        return changed;
      },
    };
  }

  // Small, deterministic cotton loops. Geometry has a second physical UV set,
  // so thread density is independent of the print-file dimensions and size.
  function fabricMap(THREE, ribbed = false) {
    const pixels = new Uint8Array(128 * 128 * 4);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      const p = (y * 128 + x) * 4;
      const yarn = ribbed ? .65 * Math.cos(x * Math.PI / 4) + .12 * Math.sin(y * Math.PI / 2) :
        .37 * Math.sin((x + Math.sin(y * Math.PI / 4) * 1.3) * Math.PI / 4) * Math.cos(y * Math.PI / 4) +
        .15 * Math.sin(x * 1.73 + y * 2.31) + .08 * Math.sin(x * 4.17 - y * 1.29);
      pixels[p] = pixels[p + 1] = pixels[p + 2] = 128 + yarn * 90; pixels[p + 3] = 255;
    }
    const map = new THREE.DataTexture(pixels, 128, 128, THREE.RGBAFormat);
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.magFilter = THREE.LinearFilter; map.minFilter = THREE.LinearMipmapLinearFilter;
    map.generateMipmaps = true; map.needsUpdate = true; return map;
  }

  function create(THREE, group, texture, product) {
    const model = product.previewModel, data = pattern(model), sim = simulate(data, model);
    const bump = fabricMap(THREE), ribBump = fabricMap(THREE, true);
    const heavy = model.fabricWeight >= 300, colour = new THREE.Color(model.color), dark = model.color === '#0b0b0b';
    function material(map, ribbed = false) {
      const m = new THREE.MeshPhysicalMaterial({ color: map ? '#ffffff' : model.color, map,
        roughness: .94, metalness: 0, bumpMap: ribbed ? ribBump : bump, bumpScale: ribbed ? .035 : heavy ? .012 : .009,
        side: THREE.DoubleSide, sheen: dark ? .35 : .14, sheenColor: new THREE.Color(dark ? '#85817d' : '#ffffff'),
        sheenRoughness: .95, specularIntensity: dark ? .7 : .22 });
      m.onBeforeCompile = shader => {
        shader.uniforms.wwFabric = { value: colour };
        shader.vertexShader = 'attribute vec2 fabricUv; varying vec2 vCottonUv;\n' + shader.vertexShader.replace('#include <uv_vertex>',
          '#include <uv_vertex>\nvCottonUv = fabricUv;');
        shader.fragmentShader = 'uniform vec3 wwFabric; varying vec2 vCottonUv;\n' + shader.fragmentShader
          .replace('#include <bumpmap_pars_fragment>', THREE.ShaderChunk.bumpmap_pars_fragment.replaceAll('vBumpMapUv', 'vCottonUv'))
          .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= (gl_FrontFacing ? 1.0 : 0.78) * (0.98 + 0.04 * texture2D(bumpMap, vCottonUv).r);');
        if (map) shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
          vec4 ink = texture2D(map, vMapUv);
          float inside = step(0.0, vMapUv.x) * step(vMapUv.x, 1.0) * step(0.0, vMapUv.y) * step(vMapUv.y, 1.0);
          diffuseColor.rgb *= mix(wwFabric, ink.rgb, inside * ink.a);
        `);
      };
      m.customProgramCacheKey = () => 'cotton-physical-v3-' + Boolean(map) + '-' + ribbed;
      return m;
    }
    const plain = material(null), printed = material(texture), rib = material(null, true);
    rib.color.multiplyScalar(.965);
    const lining = material(null); lining.vertexColors = true;
    const hood = material(null); hood.vertexColors = true;
    const pocket = material(null); pocket.vertexColors = true;
    const owned = new Set([plain, printed, bump, ribBump, rib, lining, hood, pocket]);
    const meshes = data.parts.map(p => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p.ids.length * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(p.uv), 2)); geometry.setIndex(p.triangles);
      const cottonUv = p.ids.flatMap((id, i) => p.name.includes('sleeve') || /hood|pocket/.test(p.name)
        ? [p.uv[i * 2] * .55, p.uv[i * 2 + 1] * .55]
        : [data.rest[id * 3] * .55, data.rest[id * 3 + 1] * .55]);
      geometry.setAttribute('fabricUv', new THREE.Float32BufferAttribute(cottonUv, 2));
      geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(p.ids.length * 3), 3).setUsage(THREE.DynamicDrawUsage));
      if (p.shade) geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(p.shade.flatMap(value => [value, value, value])), 3));
      const base = p.name === 'garment-hood-lining' ? lining : p.name === 'garment-hood' ? hood : p.name === 'garment-kangaroo-pocket' ? pocket : p.material === 'print' ? printed : plain;
      let materials = base;
      if (heavy && /garment-(?:front|back|sleeve)/.test(p.name)) {
        materials = [base, rib];
        let start = 0, selected = -1;
        for (let t = 0; t < p.triangles.length; t += 3) {
          const ids = p.triangles.slice(t, t + 3).map(i => p.ids[i]);
          const isRib = p.name.includes('sleeve')
            ? t >= p.triangles.length * (1 - 3 / p.rows)
            : ids.every(id => data.rest[id * 3 + 1] <= -model.height / 2 + data.bandHeight + .001);
          const current = isRib ? 1 : 0;
          if (current !== selected) { if (selected >= 0) geometry.addGroup(start, t - start, selected); start = t; selected = current; }
        }
        geometry.addGroup(start, p.triangles.length - start, selected);
      }
      const mesh = new THREE.Mesh(geometry, materials);
      // The folded hood uses baked cavity occlusion. Sub-centimetre folds
      // cannot receive a stable shadow at gallery resolution; the outer
      // layer still casts the hood's contact shadow onto the shoulders.
      mesh.castShadow = p.name !== 'garment-hood-lining';
      mesh.receiveShadow = !p.name.startsWith('garment-hood'); mesh.name = p.name; mesh.frustumCulled = false; mesh.userData.garmentPart = p; group.add(mesh); return mesh;
    });
    const details = [];
    const thread = new THREE.MeshStandardMaterial({ color: new THREE.Color(model.color).multiplyScalar(.91), roughness: 1 }); owned.add(thread);
    function seam(ids, radius, name, mat = rib, band = 0) {
      const count = ids.length, radial = band ? 8 : 6;
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(count * radial * 3), uv = new Float32Array(count * radial * 2), indices = [];
      for (let i = 0; i < count; i++) for (let r = 0; r < radial; r++) {
        const p = (i * radial + r) * 2; uv[p] = i / 3; uv[p + 1] = r / radial;
        if (i < count - 1) { const a = i * radial + r, b = i * radial + (r + 1) % radial, c = a + radial, d = b + radial; indices.push(a, b, c, b, d, c); }
      }
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geometry.setAttribute('fabricUv', new THREE.BufferAttribute(uv.slice(), 2)); geometry.setIndex(indices);
      const mesh = new THREE.Mesh(geometry, mat); mesh.castShadow = mesh.receiveShadow = true; mesh.name = name; mesh.frustumCulled = false; group.add(mesh);
      details.push({ mesh, ids, radius, radial, band }); return mesh;
    }
    const neckLine = ids => ids.filter(id => Math.abs(data.rest[id * 3]) <= model.width * .175);
    if (model.garment !== 'hoodie') {
      const neckLoop = [...neckLine(data.neckFront), ...neckLine(data.neckBack).reverse()];
      neckLoop.push(neckLoop[0]);
      seam(neckLoop, .13, 'garment-ribbed-collar', rib, heavy ? 2.2 : 2.0);
    }
    seam([...data.hemFront, ...data.hemBack.slice().reverse()], .075, 'garment-bottom-hem');
    data.cuffs.forEach((ids, i) => seam(ids, .08, `garment-cuff-${i}`));
    for (const p of data.parts.filter(p => /garment-(front|back)$/.test(p.name))) {
      const stride = p.columns + 1;
      for (const row of heavy ? [3] : [1, 2]) {
        seam(p.ids.slice(row * stride, (row + 1) * stride), .024, 'garment-hem-topstitch', thread);
      }
      const top = p.ids.slice(-stride);
      for (const sign of [-1, 1]) {
        const shoulderIds = top.filter(id => sign * data.rest[id * 3] > model.width * .17);
        seam(shoulderIds, .032, 'garment-shoulder-seam', thread);
      }
    }
    for (const p of data.parts.filter(p => p.name.includes('sleeve'))) {
      const stride = p.columns + 1;
      seam(p.ids.slice(0, stride), .035, 'garment-armhole-seam', thread);
      const row = p.rows - (heavy ? 3 : 1);
      seam(p.ids.slice(row * stride, (row + 1) * stride), .025, 'garment-cuff-topstitch', thread);
    }
    if (model.garment === 'hoodie') {
      seam(data.hoodRim, .23, 'garment-hood-binding');
      seam(data.hoodCenter, .075, 'garment-hood-center-seam', plain);
      const pocketPart = data.parts.find(p => p.name === 'garment-kangaroo-pocket');
      const pocketEdge = [];
      const stride = pocketPart.columns + 1;
      for (let y = pocketPart.rows; y >= 0; y--) pocketEdge.push(pocketPart.ids[y * stride]);
      for (let x = 1; x <= pocketPart.columns; x++) pocketEdge.push(pocketPart.ids[x]);
      for (let y = 1; y <= pocketPart.rows; y++) pocketEdge.push(pocketPart.ids[y * stride + pocketPart.columns]);
      seam(pocketEdge, .09, 'garment-pocket-stitching', thread);
      seam(pocketPart.ids.slice(-stride), .045, 'garment-pocket-topstitch', thread);
      // The supplier ties short round cords across the throat. The cords
      // follow the neck anchors during a pull, including the small aglets.
      const cord = new THREE.MeshPhysicalMaterial({ color: model.color, roughness: .98, sheen: .18 }); owned.add(cord);
      const metal = new THREE.MeshStandardMaterial({ color: dark ? '#383735' : '#b6b4af', metalness: .68, roughness: .44 }); owned.add(metal);
      function cordMesh(points, anchor, name = 'garment-drawstring') {
        const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
        const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 36, .18, 8, false), cord);
        mesh.castShadow = true; mesh.name = name; group.add(mesh);
        details.push({ mesh, anchor, initial: mesh.position.clone() }); return mesh;
      }
      for (const sign of [-1, 1]) {
        const anchor = data.neckFront[Math.round((.5 + sign * .06) * 32)];
        const x = sign * model.width * .049, y = model.height / 2 - model.height * .065, z = model.width * .115 * .73 + .9;
        const points = [[x,y,z], [x * .7,y - .4,z + .7], [-sign * .5,y - 1.2,z + 1],
          [sign * 1.4,y - .9,z + 1.3], [sign * 2.5,y - .1,z + 1.5], [sign * 3,y - .6,z + 1.6],
          [sign * 1.3,y - 1.7,z + 1.5], [-sign * .5,y - 1.3,z + 1.4],
          [-sign * 2.2,y - 2.1,z + 1.5], [-sign * 3.6,y - 3.2 - (sign > 0 ? .7 : 0),z + 1.4]];
        cordMesh(points, anchor);
        const eyelet = new THREE.Mesh(new THREE.TorusGeometry(.30, .075, 8, 20), metal);
        eyelet.position.set(x,y,z); eyelet.name = 'garment-eyelet'; group.add(eyelet);
        const tip = new THREE.Mesh(new THREE.CylinderGeometry(.18, .18, .85, 10), metal);
        tip.position.fromArray(points.at(-1)); tip.rotation.z = -sign * .7; tip.name = 'garment-drawstring-tip'; group.add(tip);
        for (const mesh of [eyelet, tip]) details.push({ mesh, anchor, initial: mesh.position.clone() });
      }

    }
    const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), tangent = new THREE.Vector3(), normal = new THREE.Vector3(), binormal = new THREE.Vector3();
    // Meshes keep their own UVs/materials, but welded seam nodes share one
    // area-weighted normal. Independent per-panel normals made the armholes
    // look like hard-edged blocks even when their positions were stitched.
    const normalSums = new Float32Array(data.rest.length);
    const faces = new Uint32Array(data.parts.flatMap(p => p.triangles.map(i => p.ids[i] * 3)));
    let disposed = false, demonstration = null;
    function sync() {
      normalSums.fill(0);
      const positions = sim.positions;
      for (let i = 0; i < faces.length; i += 3) {
        const a = faces[i], b = faces[i + 1], c = faces[i + 2];
        const abx = positions[b] - positions[a], aby = positions[b + 1] - positions[a + 1], abz = positions[b + 2] - positions[a + 2];
        const acx = positions[c] - positions[a], acy = positions[c + 1] - positions[a + 1], acz = positions[c + 2] - positions[a + 2];
        const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
        for (let k = 0; k < 3; k++) { const p = faces[i + k]; normalSums[p] += nx; normalSums[p + 1] += ny; normalSums[p + 2] += nz; }
      }
      for (let p = 0; p < normalSums.length; p += 3) {
        const length = Math.sqrt(normalSums[p] ** 2 + normalSums[p + 1] ** 2 + normalSums[p + 2] ** 2) || 1;
        normalSums[p] /= length; normalSums[p + 1] /= length; normalSums[p + 2] /= length;
      }
      for (const mesh of meshes) {
        const attr = mesh.geometry.attributes.position, normals = mesh.geometry.attributes.normal, ids = mesh.userData.garmentPart.ids;
        for (let i = 0; i < ids.length; i++) {
          const p = ids[i] * 3;
          attr.setXYZ(i, positions[p] * 100, positions[p + 1] * 100, positions[p + 2] * 100);
          normals.setXYZ(i, normalSums[p], normalSums[p + 1], normalSums[p + 2]);
        }
        attr.needsUpdate = true; normals.needsUpdate = true;
        if (!mesh.geometry.boundingSphere) {
          mesh.geometry.computeBoundingSphere(); mesh.geometry.boundingSphere.radius += model.height * .4;
        }
      }

      for (const detail of details) {
        if (detail.anchor != null) {
          const p = detail.anchor * 3;
          detail.mesh.position.copy(detail.initial).add(v1.fromArray(sim.positions, p).multiplyScalar(100).sub(v2.fromArray(data.rest, p)));
          continue;
        }
        const { mesh, ids, radius, radial, band } = detail, attr = mesh.geometry.attributes.position;
        for (let i = 0; i < ids.length; i++) {
          v1.fromArray(sim.positions, ids[Math.max(0, i - 1)] * 3); v2.fromArray(sim.positions, ids[Math.min(ids.length - 1, i + 1)] * 3);
          tangent.subVectors(v2, v1).normalize(); normal.set(0, 0, 1);
          if (Math.abs(tangent.z) > .9) normal.set(0, 1, 0);
          binormal.crossVectors(tangent, normal).normalize(); normal.crossVectors(binormal, tangent).normalize();
          v1.fromArray(sim.positions, ids[i] * 3).multiplyScalar(100);
          for (let r = 0; r < radial; r++) { const a = r / radial * Math.PI * 2;
            if (band) {
              const outward = normal.set(v1.x, 0, v1.z).normalize();
              const t = (1 - Math.cos(a)) / 2;
              attr.setXYZ(i * radial + r, v1.x + outward.x * (1.4 * t + radius * Math.sin(a)),
                v1.y + .15 - band * t, v1.z + outward.z * (1.3 * t + radius * Math.sin(a)));
            } else attr.setXYZ(i * radial + r, v1.x + radius * (normal.x * Math.cos(a) + binormal.x * Math.sin(a)),
              v1.y + radius * (normal.y * Math.cos(a) + binormal.y * Math.sin(a)), v1.z + radius * (normal.z * Math.cos(a) + binormal.z * Math.sin(a)));
          }
        }
        attr.needsUpdate = true; mesh.geometry.computeVertexNormals();
        if (!mesh.geometry.boundingSphere) { mesh.geometry.computeBoundingSphere(); mesh.geometry.boundingSphere.radius += model.height * .4; }
      }
    }
    sync();
    return { meshes, simulation: sim, pattern: data,
      get active() { return !disposed && sim.active; },
      beginGrab(hit) {
        if (disposed || !hit?.object?.userData.garmentPart || !hit.face) return false;
        demonstration = null;
        const ids = hit.object.userData.garmentPart.ids;
        const candidates = [hit.face.a, hit.face.b, hit.face.c].map(i => ids[i]);
        hit.object.worldToLocal(v1.copy(hit.point));
        candidates.sort((a, b) => v2.fromArray(sim.positions, a * 3).multiplyScalar(100).distanceToSquared(v1) - v2.fromArray(sim.positions, b * 3).multiplyScalar(100).distanceToSquared(v1));
        return sim.grab(candidates[0]);
      },
      moveGrab(worldPoint) { if (!disposed) { group.worldToLocal(v1.copy(worldPoint)); sim.move([v1.x, v1.y, v1.z]); } },
      release() { demonstration = null; sim.release(); },
      demonstrate() {
        if (disposed) return;
        const id = data.parts[0].ids[10 * 33 + 25]; sim.grab(id);
        demonstration = { time: 0, from: Array.from(sim.positions.subarray(id * 3, id * 3 + 3), p => p * 100) };
      },
      advance(elapsed) {
        if (disposed) return false;
        if (demonstration) {
          demonstration.time += Math.min(.04, elapsed); const { time, from } = demonstration;
          if (time < 1.6) { const pull = Math.sin(time / 1.6 * Math.PI); sim.move([from[0] + 11 * pull, from[1] + 7 * pull, from[2] + 14 * pull]); }
          else { demonstration = null; sim.release(); }
        }
        const changed = sim.advance(elapsed); if (changed) sync(); return changed;
      },
      dispose() {
        if (disposed) return; disposed = true; demonstration = null; sim.release(); sim.sleep();
        for (const mesh of [...meshes, ...details.map(d => d.mesh)]) { group.remove(mesh); mesh.geometry.dispose(); }
        owned.forEach(resource => resource.dispose());
      },
    };
  }
  return Object.freeze({ create, pattern, simulate, STEP });
});
