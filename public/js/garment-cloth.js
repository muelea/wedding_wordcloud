(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GarmentCloth = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const STEP = 1 / 90;
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = t => t * t * (3 - 2 * t);

  // Pattern coordinates are centimetres. The paired panels share side and
  // shoulder seams, but retain real neck, sleeve and hem openings.
  function pattern(model) {
    const { width: w, height: h, sleeve } = model;
    const tee = model.garment === 't-shirt', hoodie = model.garment === 'hoodie';
    const cols = 32, lower = 24, upper = 12, rows = lower + upper;
    const depth = w * (tee ? .115 : .125), neck = w * (hoodie ? .17 : .165);
    const vertices = [], parts = [], lookup = new Map(), pins = new Set();
    const neckFront = [], neckBack = [], hemFront = [], hemBack = [], cuffs = [];
    const point = position => {
      const key = position.map(v => Math.round(v * 10000)).join(',');
      if (lookup.has(key)) return lookup.get(key);
      const id = vertices.length / 3; vertices.push(...position); lookup.set(key, id); return id;
    };
    const part = (name, material) => { const p = { name, material, ids: [], uv: [], triangles: [] }; parts.push(p); return p; };
    function grid(p, nx, ny, sample, uv, reverse = false) {
      const start = p.ids.length;
      for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) {
        const pos = sample(x / nx, y / ny, x, y), id = point(pos);
        p.ids.push(id); p.uv.push(...uv(pos, x / nx, y / ny));
      }
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const a = start + y * (nx + 1) + x, b = a + 1, c = a + nx + 1, d = c + 1;
        p.triangles.push(...(reverse ? [a, b, c, b, d, c] : [a, c, b, b, c, d]));
      }
    }
    function body(u, v, side) {
      const a = Math.abs(u), top = h / 2;
      const armpit = top - h * .275;
      const shoulderY = top - h * .038;
      const shoulderHalf = w * .455;
      const shoulderDrop = h * .038 * Math.max(0, (a * shoulderHalf - neck) / (shoulderHalf - neck));
      const neckCurve = Math.sqrt(Math.max(0, 1 - (u * shoulderHalf / neck) ** 2));
      const topY = top - shoulderDrop - neckCurve * h * (side > 0 ? .068 : .022);
      const upperT = Math.max(0, (v * rows - lower) / upper);
      const y = v <= lower / rows ? mix(-top, armpit, v * rows / lower) : mix(armpit, topY, upperT);
      const half = v <= lower / rows ? w * (.485 + .015 * Math.sin(v * rows / lower * Math.PI / 2)) : mix(w / 2, shoulderHalf, upperT);
      const x = u * half;
      const sideOpening = Math.sin(upperT * Math.PI) * depth * .82;
      let z = depth * Math.pow(Math.max(0, 1 - a ** 4), .5) * (.87 + .13 * Math.sin(v * Math.PI));
      if (v > lower / rows) {
        z = mix(z, neckCurve * depth * .67, smooth(upperT) ** 3);
        z += sideOpening * a ** 8;
      }
      // Subtle sewn-in folds, without the plush pile of the blanket material.
      z += Math.sin(u * 15 + v * 8) * Math.sin(v * Math.PI) * (1 - a ** 4) * (tee ? .72 : .55);
      z += Math.sin((a - v * .3) * 27) * Math.exp(-(((v - .78) / .19) ** 2)) * a ** 2 * (1 - a ** 2) * 3;
      z += Math.sin(u * 14 + 1) * Math.exp(-(((v - .10) / .12) ** 2)) * (1 - a ** 3) * (tee ? .55 : .8);
      return [x, y, z * side];
    }
    for (const side of [1, -1]) {
      const p = part(side > 0 ? 'garment-front' : 'garment-back', side > 0 ? 'print' : 'fabric');
      grid(p, cols, rows, (u, v) => body(u * 2 - 1, v, side), pos => [
        pos[0] / model.printWidth + .5,
        1 - (h / 2 - model.printTop - pos[1]) / model.printHeight,
      ], side > 0);
      const neckLine = side > 0 ? neckFront : neckBack, hem = side > 0 ? hemFront : hemBack;
      for (let x = 0; x <= cols; x++) {
        const i = rows * (cols + 1) + x, pos = p.ids[i];
        neckLine.push(pos); hem.push(p.ids[x]);
        if (Math.abs(vertices[pos * 3]) > neck && Math.abs(vertices[pos * 3]) < w * .45) pins.add(pos);
      }
    }
    for (const sign of [-1, 1]) {
      const ring = upper * 2, segments = tee ? 12 : 24;
      const angle = (tee ? 48 : 18) * Math.PI / 180;
      const axis = [sign * Math.sin(angle), -Math.cos(angle), 0];
      const radial = [sign * Math.cos(angle), Math.sin(angle), 0];
      const center = [sign * w * .478, h / 2 - h * .157, 0];
      const length = sleeve * (tee ? .8 : .87), radius = tee ? w * .158 : w * .082;
      const p = part(`garment-sleeve-${sign}`, 'fabric');
      grid(p, ring, segments, (u, t) => {
        const k = Math.round(u * ring), front = k <= upper;
        const v = front ? 1 - k / upper : (k - upper) / upper;
        const base = body(sign, (lower + v * upper) / rows, front ? 1 : -1);
        if (!t) return base;
        const theta = u * Math.PI * 2, r = mix(h * .118, radius, smooth(t));
        const c = center.map((value, i) => value + axis[i] * length * t);
        const shape = c.map((value, i) => value + radial[i] * Math.cos(theta) * r + (i === 2 ? Math.sin(theta) * r * .79 : 0));
        const blend = smooth(Math.min(1, t * 4));
        return shape.map((value, i) => mix(base[i] + axis[i] * length * t, value, blend));
      }, (_, u, v) => [u * 8, v * sleeve / 4], sign < 0);
      cuffs.push(p.ids.slice(-ring - 1));
    }
    if (hoodie) {
      // A separate, open-faced hood: outer shell and lining have real depth.
      // Its lower edge rests around the neck, leaving the chest print visible.
      for (const inside of [false, true]) {
        const p = part(inside ? 'garment-hood-lining' : 'garment-hood', 'fabric');
        grid(p, 36, 20, (u, v) => {
          const theta = .9 + u * (Math.PI * 2 - 1.8);
          const rise = Math.sin(v * Math.PI / 2);
          const taper = Math.sqrt(Math.max(0, 1 - rise ** 2));
          const radius = (neck * 1.2 - (inside ? .27 : 0)) * taper;
          const x = Math.sin(theta) * radius + rise ** 3 * 2;
          const z = Math.cos(theta) * radius * .9 - depth * .5 - rise ** 2 * 5;
          const y = h / 2 - h * .035 + rise * 23 + Math.sin(theta) * rise * 1.1;
          return [x, y, z];
        }, (_, u, v) => [u * 8, v * 8], inside);
      }
      const p = part('garment-kangaroo-pocket', 'fabric');
      grid(p, 22, 10, (u, v) => {
        const top = h / 2 - h * .65, bottom = -h / 2 + h * .105;
        const half = w * mix(.32, .24, smooth(v));
        const x = (u * 2 - 1) * half, y = mix(bottom, top, v);
        const z = depth * Math.sqrt(1 - (x / (w * .5)) ** 4) * .97 + .55 + Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * .35;
        return [x, y, z];
      }, (_, u, v) => [u * 5, v * 3], true);
    }
    const stitches = [];
    function stitch(id, candidates) {
      let best = -1, distance = Infinity;
      for (const candidate of candidates) {
        const d = (vertices[id * 3] - vertices[candidate * 3]) ** 2 +
          (vertices[id * 3 + 1] - vertices[candidate * 3 + 1]) ** 2 + (vertices[id * 3 + 2] - vertices[candidate * 3 + 2]) ** 2;
        if (d < distance) { best = candidate; distance = d; }
      }
      if (best >= 0 && best !== id) stitches.push([id, best]);
    }
    if (hoodie) {
      for (const p of parts.filter(p => p.name.startsWith('garment-hood'))) {
        for (const id of p.ids.slice(0, 37)) stitch(id, [...neckFront, ...neckBack]);
      }
      const p = parts.find(p => p.name === 'garment-kangaroo-pocket');
      for (let y = 0; y <= 10; y++) for (let x = 0; x <= 22; x++) {
        if (!y || !x || x === 22) stitch(p.ids[y * 23 + x], parts[0].ids);
      }
    }
    return { rest: new Float32Array(vertices), parts, stitches, pins: [...pins], neckFront, neckBack, hemFront, hemBack, cuffs };
  }

  function simulate(pattern, model) {
    const rest = Float32Array.from(pattern.rest, p => p / 100), positions = rest.slice(), previous = rest.slice();
    const count = rest.length / 3, pinned = new Set(pattern.pins), edges = new Map(), opposites = new Map();
    const heavy = model.fabricWeight >= 300;
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
    const targets = [0, 0, 0];
    let grabbed = -1, awake = false, quiet = 0, age = 0, accumulator = 0;
    function wake() { awake = true; quiet = 0; age = 0; }
    function step() {
      for (let i = 0; i < count; i++) {
        if (pinned.has(i) || i === grabbed) continue;
        for (let k = 0; k < 3; k++) {
          const p = i * 3 + k, value = positions[p];
          const velocity = (value - previous[p]) * (heavy ? .963 : .978);
          previous[p] = value;
          // The photographed hanging shape is the equilibrium state. Gentle
          // support preserves the empty garment's volume while local pulls
          // still propagate through its stitched panels and sleeves.
          positions[p] = value + velocity + (rest[p] - value) * (heavy ? .009 : .005);
        }
      }
      for (let pass = 0; pass < 6; pass++) {
        if (grabbed >= 0) for (let k = 0; k < 3; k++) positions[grabbed * 3 + k] = targets[k];
        for (const { a, b, length, bend } of links) {
          const wa = pinned.has(a) || a === grabbed ? 0 : 1, wb = pinned.has(b) || b === grabbed ? 0 : 1;
          if (!(wa + wb)) continue;
          const p = a * 3, q = b * 3;
          const dx = positions[p] - positions[q], dy = positions[p + 1] - positions[q + 1], dz = positions[p + 2] - positions[q + 2];
          const d = Math.hypot(dx, dy, dz); if (d < 1e-8) continue;
          const correction = (d - length) / d / (wa + wb) * (bend ? heavy ? .55 : .22 : .96);
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
    function release() { if (grabbed < 0) return; grabbed = -1; wake(); }
    function sleep() { awake = false; accumulator = 0; previous.set(positions); }
    return { positions, rest, pins: pattern.pins, release, move, sleep,
      get active() { return awake; }, get grabbed() { return grabbed; },
      grab(id) {
        if (!Number.isInteger(id) || id < 0 || id >= count || pinned.has(id)) return false;
        grabbed = id; move(Array.from(positions.subarray(id * 3, id * 3 + 3), v => v * 100)); return true;
      },
      advance(elapsed) {
        if (!awake || !Number.isFinite(elapsed) || elapsed <= 0) return false;
        accumulator = Math.min(accumulator + elapsed, STEP * 4); let changed = false;
        while (accumulator >= STEP) {
          step(); changed = true; accumulator -= STEP; age += STEP;
          if (grabbed < 0) {
            let energy = 0; for (let p = 0; p < positions.length; p++) energy += (positions[p] - previous[p]) ** 2;
            quiet = energy / count < 2e-10 ? quiet + STEP : 0;
            if (quiet > .5 || age > 12) { sleep(); break; }
          }
        }
        return changed;
      },
    };
  }

  let knit;
  function fabricMap(THREE) {
    if (!knit) {
      knit = new Uint8Array(128 * 128 * 4);
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
        const p = (y * 128 + x) * 4;
        const loop = Math.sin((x + Math.sin(y * Math.PI / 8) * 1.7) * Math.PI / 4) * Math.cos(y * Math.PI / 8);
        knit[p] = knit[p + 1] = knit[p + 2] = 135 + loop * 65; knit[p + 3] = 255;
      }
    }
    const map = new THREE.DataTexture(knit, 128, 128, THREE.RGBAFormat);
    map.wrapS = map.wrapT = THREE.RepeatWrapping; map.repeat.set(28, 34);
    map.magFilter = THREE.LinearFilter; map.minFilter = THREE.LinearMipmapLinearFilter; map.generateMipmaps = true; map.needsUpdate = true;
    return map;
  }

  function create(THREE, group, texture, product) {
    const model = product.previewModel, data = pattern(model), sim = simulate(data, model), bump = fabricMap(THREE);
    const heavy = model.fabricWeight >= 300, colour = new THREE.Color(model.color);
    const material = map => {
      const m = new THREE.MeshPhysicalMaterial({ color: map ? '#ffffff' : model.color, map,
        roughness: .94, metalness: 0, sheen: map ? 0 : .2,
        sheenColor: new THREE.Color(model.color === '#0b0b0b' ? '#555555' : model.color), sheenRoughness: .9,
        specularIntensity: .15, bumpMap: bump, bumpScale: heavy ? .024 : .015, side: THREE.DoubleSide });
      if (map) {
        m.onBeforeCompile = shader => {
          shader.uniforms.wwFabric = { value: colour };
          shader.fragmentShader = 'uniform vec3 wwFabric;\n' + shader.fragmentShader.replace('#include <map_fragment>', `
            vec4 ink = texture2D(map, vMapUv);
            float inside = step(0.0, vMapUv.x) * step(vMapUv.x, 1.0) * step(0.0, vMapUv.y) * step(vMapUv.y, 1.0);
            diffuseColor.rgb *= mix(wwFabric, ink.rgb, inside * ink.a);
          `);
        };
        m.customProgramCacheKey = () => 'organic-cotton-print-v1';
      }
      return m;
    };
    const plain = material(null), printed = material(texture);
    const rib = plain.clone(); rib.roughness = .98; rib.bumpScale = .08;
    const lining = plain.clone(); lining.color.multiplyScalar(.65);
    const pocket = plain.clone(); pocket.color.multiplyScalar(.93);
    const owned = new Set([plain, printed, bump, rib, lining, pocket]);
    const meshes = data.parts.map(p => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p.ids.length * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(p.uv), 2)); geometry.setIndex(p.triangles);
      const base = p.name === 'garment-hood-lining' ? lining : p.name === 'garment-kangaroo-pocket' ? pocket : p.material === 'print' ? printed : plain;
      let materials = base;
      if (heavy && /garment-(?:front|back|sleeve)/.test(p.name)) {
        materials = [base, rib];
        let start = 0, selected = -1;
        for (let t = 0; t < p.triangles.length; t += 3) {
          const ids = p.triangles.slice(t, t + 3).map(i => p.ids[i]);
          const isRib = p.name.includes('sleeve')
            ? t >= p.triangles.length * (1 - 5.5 / model.sleeve)
            : ids.every(id => data.rest[id * 3 + 1] < -model.height / 2 + 5.5);
          const current = isRib ? 1 : 0;
          if (current !== selected) { if (selected >= 0) geometry.addGroup(start, t - start, selected); start = t; selected = current; }
        }
        geometry.addGroup(start, p.triangles.length - start, selected);
      }
      const mesh = new THREE.Mesh(geometry, materials);
      mesh.name = p.name; mesh.frustumCulled = false; mesh.userData.garmentPart = p; group.add(mesh); return mesh;
    });
    const details = [];
    function seam(ids, radius, name, mat = rib) {
      const count = ids.length, radial = 6;
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(count * radial * 3), uv = new Float32Array(count * radial * 2), indices = [];
      for (let i = 0; i < count; i++) for (let r = 0; r < radial; r++) {
        const p = (i * radial + r) * 2; uv[p] = i / 3; uv[p + 1] = r / radial;
        if (i < count - 1) { const a = i * radial + r, b = i * radial + (r + 1) % radial, c = a + radial, d = b + radial; indices.push(a, b, c, b, d, c); }
      }
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geometry.setIndex(indices);
      const mesh = new THREE.Mesh(geometry, mat); mesh.name = name; mesh.frustumCulled = false; group.add(mesh);
      details.push({ mesh, ids, radius, radial }); return mesh;
    }
    const neckLine = ids => ids.filter(id => Math.abs(data.rest[id * 3]) <= model.width * .17);
    seam([...neckLine(data.neckFront), ...neckLine(data.neckBack).reverse()], heavy ? .5 : .38, 'garment-ribbed-collar');
    seam([...data.hemFront, ...data.hemBack.slice().reverse()], heavy ? .62 : .16, 'garment-bottom-hem');
    data.cuffs.forEach((ids, i) => seam(ids, heavy ? .55 : .16, `garment-cuff-${i}`));
    if (model.garment === 'hoodie') {
      const pocketPart = data.parts.find(p => p.name === 'garment-kangaroo-pocket');
      const pocketEdge = [];
      for (let y = 10; y >= 0; y--) pocketEdge.push(pocketPart.ids[y * 23]);
      for (let x = 1; x <= 22; x++) pocketEdge.push(pocketPart.ids[x]);
      for (let y = 1; y <= 10; y++) pocketEdge.push(pocketPart.ids[y * 23 + 22]);
      seam(pocketEdge, .12, 'garment-pocket-stitching', rib);
      // Drawstrings, eyelets and their metal tips follow the neck when tugged.
      const metal = new THREE.MeshStandardMaterial({ color: '#a7a5a0', metalness: .8, roughness: .32 }); owned.add(metal);
      for (const sign of [-1, 1]) {
        const anchor = data.neckFront[Math.round((.5 + sign * .1) * 32)];
        const rope = [];
        for (let n = 0; n <= 14; n++) {
          const p = anchor * 3, t = n / 14;
          rope.push([data.rest[p] + sign * (.8 * t + Math.sin(t * 4) * .35), data.rest[p + 1] - 19 * t, data.rest[p + 2] + 1.1 + Math.sin(t * Math.PI) * .8]);
        }
        const curve = new THREE.CatmullRomCurve3(rope.map(p => new THREE.Vector3(...p)));
        const string = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, .17, 6, false), rib); string.name = 'garment-drawstring'; group.add(string);
        const eyelet = new THREE.Mesh(new THREE.TorusGeometry(.38, .10, 6, 16), metal); eyelet.position.fromArray(rope[0]); eyelet.name = 'garment-eyelet'; group.add(eyelet);
        const tip = new THREE.Mesh(new THREE.CylinderGeometry(.19, .19, 1.3, 8), metal); tip.position.fromArray(rope.at(-1)); tip.name = 'garment-drawstring-tip'; group.add(tip);
        for (const mesh of [string, eyelet, tip]) details.push({ mesh, anchor, initial: mesh.position.clone() });
      }
    }
    const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), tangent = new THREE.Vector3(), normal = new THREE.Vector3(), binormal = new THREE.Vector3();
    let disposed = false, demonstration = null;
    function sync() {
      for (const mesh of meshes) {
        const attr = mesh.geometry.attributes.position, ids = mesh.userData.garmentPart.ids;
        ids.forEach((id, i) => attr.setXYZ(i, sim.positions[id * 3] * 100, sim.positions[id * 3 + 1] * 100, sim.positions[id * 3 + 2] * 100));
        attr.needsUpdate = true; mesh.geometry.computeVertexNormals(); mesh.geometry.computeBoundingSphere();
      }
      for (const detail of details) {
        if (detail.anchor != null) {
          const p = detail.anchor * 3;
          detail.mesh.position.copy(detail.initial).add(v1.fromArray(sim.positions, p).multiplyScalar(100).sub(v2.fromArray(data.rest, p)));
          continue;
        }
        const { mesh, ids, radius, radial } = detail, attr = mesh.geometry.attributes.position;
        for (let i = 0; i < ids.length; i++) {
          v1.fromArray(sim.positions, ids[Math.max(0, i - 1)] * 3); v2.fromArray(sim.positions, ids[Math.min(ids.length - 1, i + 1)] * 3);
          tangent.subVectors(v2, v1).normalize(); normal.set(0, 0, 1);
          if (Math.abs(tangent.z) > .9) normal.set(0, 1, 0);
          binormal.crossVectors(tangent, normal).normalize(); normal.crossVectors(binormal, tangent).normalize();
          v1.fromArray(sim.positions, ids[i] * 3).multiplyScalar(100);
          for (let r = 0; r < radial; r++) { const a = r / radial * Math.PI * 2;
            attr.setXYZ(i * radial + r, v1.x + radius * (normal.x * Math.cos(a) + binormal.x * Math.sin(a)),
              v1.y + radius * (normal.y * Math.cos(a) + binormal.y * Math.sin(a)), v1.z + radius * (normal.z * Math.cos(a) + binormal.z * Math.sin(a)));
          }
        }
        attr.needsUpdate = true; mesh.geometry.computeVertexNormals(); mesh.geometry.computeBoundingSphere();
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
