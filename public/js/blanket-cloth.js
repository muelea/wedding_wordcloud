(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BlanketCloth = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const STEP = 1 / 90;
  const WIDTH = 2.8;
  const MAX_SETTLE_SECONDS = 8;

  // Simulation coordinates are normalized; the visible shell is in centimetres.
  // None of these positions or material effects enters the editable print file.
  function simulate(model) {
    const nx = 40, ny = Math.max(24, Math.round(nx * model.height / model.width));
    const height = WIDTH * model.height / model.width, count = (nx + 1) * (ny + 1);
    const index = (x, y) => y * (nx + 1) + x;
    const positions = new Float32Array(count * 3), previous = new Float32Array(count * 3);
    const rest = new Float32Array(count * 3), inverseMass = new Float32Array(count).fill(1);
    for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) {
      const p = index(x, y) * 3, u = x / nx, v = y / ny;
      // Spread the hanging corners almost to the full width, leaving a little
      // slack for folds while keeping the upper artwork open and readable.
      positions[p] = (u - .5) * WIDTH * .98;
      positions[p + 1] = height / 2 - v * height;
      positions[p + 2] = .13 * Math.sin(u * Math.PI * 3 + .3) * Math.sin(v * Math.PI * .83) + .09 * Math.sin(u * Math.PI) * Math.sin(v * Math.PI);
    }
    rest.set(positions); previous.set(positions); inverseMass[0] = inverseMass[nx] = 0;
    const ids = [], lengths = [], compliance = [], dx = WIDTH / nx, dy = height / ny;
    const link = (a, b, length, softness) => { ids.push(a, b); lengths.push(length); compliance.push(softness); };
    for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) {
      const i = index(x, y);
      if (x < nx) link(i, index(x + 1, y), dx, .00000015);
      if (y < ny) link(i, index(x, y + 1), dy, .00000015);
      if (x < nx && y < ny) {
        link(i, index(x + 1, y + 1), Math.hypot(dx, dy), .0000008);
        link(index(x + 1, y), index(x, y + 1), Math.hypot(dx, dy), .0000008);
      }
      if (x < nx - 1) link(i, index(x + 2, y), dx * 2, .00012);
      if (y < ny - 1) link(i, index(x, y + 2), dy * 2, .00012);
      if (x < nx - 2) link(i, index(x + 3, y), dx * 3, .00085);
      if (y < ny - 2) link(i, index(x, y + 3), dy * 3, .00085);
    }
    const links = new Uint16Array(ids), distance = new Float32Array(lengths);
    const softness = new Float32Array(compliance), lambda = new Float32Array(lengths.length);
    const target = [0, 0, 0], grid = new Map(), next = new Int32Array(count);
    const thickness = (model.depth || .6) / model.width * WIDTH;
    const contactThickness = thickness * 1.8, cell = Math.max(.045, contactThickness);
    const gravity = 9.81 * WIDTH / (model.width / 100);
    const key = (x, y, z) => (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
    let grabbed = -1, contactStep = 0, accumulator = 0, quiet = 0, age = 0, awake = false;

    function pin() {
      for (const i of [0, nx]) for (let k = 0; k < 3; k++) positions[i * 3 + k] = rest[i * 3 + k];
      if (grabbed >= 0) for (let k = 0; k < 3; k++) positions[grabbed * 3 + k] = target[k];
    }

    function contacts() {
      grid.clear();
      for (let i = 0; i < count; i++) {
        const p = i * 3, hash = key(Math.floor(positions[p] / cell), Math.floor(positions[p + 1] / cell), Math.floor(positions[p + 2] / cell));
        next[i] = grid.get(hash) ?? -1; grid.set(hash, i);
      }
      for (let i = 0; i < count; i++) {
        const p = i * 3, cx = Math.floor(positions[p] / cell), cy = Math.floor(positions[p + 1] / cell), cz = Math.floor(positions[p + 2] / cell);
        const u = i % (nx + 1), v = Math.floor(i / (nx + 1));
        for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
          let j = grid.get(key(cx + ox, cy + oy, cz + oz)) ?? -1;
          while (j >= 0) {
            if (j < i && (Math.abs(u - j % (nx + 1)) > 1 || Math.abs(v - Math.floor(j / (nx + 1))) > 1)) {
              const q = j * 3, x = positions[p] - positions[q], y = positions[p + 1] - positions[q + 1], z = positions[p + 2] - positions[q + 2];
              const square = x * x + y * y + z * z;
              if (square < contactThickness * contactThickness && square > .00000001) {
                const wa = i === grabbed ? 0 : inverseMass[i], wb = j === grabbed ? 0 : inverseMass[j], weight = wa + wb;
                if (weight) {
                  const length = Math.sqrt(square), scale = (contactThickness - length) / length / weight * .65;
                  positions[p] += x * scale * wa; positions[p + 1] += y * scale * wa; positions[p + 2] += z * scale * wa;
                  positions[q] -= x * scale * wb; positions[q + 1] -= y * scale * wb; positions[q + 2] -= z * scale * wb;
                }
              }
            }
            j = next[j];
          }
        }
      }
    }

    function step() {
      for (let i = 0; i < count; i++) {
        if (!inverseMass[i] || i === grabbed) continue;
        const p = i * 3;
        for (let k = 0; k < 3; k++) {
          const value = positions[p + k], velocity = (value - previous[p + k]) * .988;
          previous[p + k] = value;
          positions[p + k] = value + velocity - (k === 1 ? gravity * STEP * STEP : 0);
        }
      }
      lambda.fill(0);
      for (let iteration = 0; iteration < 8; iteration++) {
        pin();
        for (let c = 0; c < distance.length; c++) {
          const a = links[c * 2], b = links[c * 2 + 1], p = a * 3, q = b * 3;
          const wa = a === grabbed ? 0 : inverseMass[a], wb = b === grabbed ? 0 : inverseMass[b], weight = wa + wb;
          if (!weight) continue;
          const x = positions[p] - positions[q], y = positions[p + 1] - positions[q + 1], z = positions[p + 2] - positions[q + 2];
          const length = Math.hypot(x, y, z);
          if (length < .000001) continue;
          const alpha = softness[c] / (STEP * STEP), change = (-(length - distance[c]) - alpha * lambda[c]) / (weight + alpha);
          lambda[c] += change;
          const scale = change / length;
          positions[p] += x * scale * wa; positions[p + 1] += y * scale * wa; positions[p + 2] += z * scale * wa;
          positions[q] -= x * scale * wb; positions[q + 1] -= y * scale * wb; positions[q + 2] -= z * scale * wb;
        }
        // The upper hem cannot be longer than its material distance to either
        // pin. Long-range limits keep gravity from overstretching the chain
        // of short edge constraints and folding it over the upper artwork.
        for (let x = 1; x < nx; x++) for (const corner of [0, nx]) {
          if (x === grabbed) continue;
          const p = index(x, 0) * 3, q = corner * 3, radius = Math.abs(x - corner) * dx;
          const vx = positions[p] - rest[q], vy = positions[p + 1] - rest[q + 1], vz = positions[p + 2] - rest[q + 2];
          const length = Math.hypot(vx, vy, vz);
          if (length > radius) {
            positions[p] = rest[q] + vx * radius / length;
            positions[p + 1] = rest[q + 1] + vy * radius / length;
            positions[p + 2] = rest[q + 2] + vz * radius / length;
          }
        }
      }
      if (++contactStep % 2 === 0) contacts();
      pin();
      if (grabbed >= 0) for (let k = 0; k < 3; k++) previous[grabbed * 3 + k] = positions[grabbed * 3 + k];
    }

    function wake() { awake = true; quiet = 0; age = 0; }
    function move(point) {
      if (grabbed < 0 || !point.every(Number.isFinite)) return;
      for (let k = 0; k < 3; k++) target[k] = point[k];
      const x = grabbed % (nx + 1), y = Math.floor(grabbed / (nx + 1));
      // Each pin bounds the material's geodesic reach. Pulling near a pin must
      // not turn the blanket into an indefinitely stretching rubber sheet.
      for (let pass = 0; pass < 4; pass++) for (const corner of [0, nx]) {
        const p = corner * 3, radius = Math.hypot((x - corner) * dx, y * dy) * 1.015;
        const vx = target[0] - rest[p], vy = target[1] - rest[p + 1], vz = target[2] - rest[p + 2], length = Math.hypot(vx, vy, vz);
        if (length > radius) { target[0] = rest[p] + vx * radius / length; target[1] = rest[p + 1] + vy * radius / length; target[2] = rest[p + 2] + vz * radius / length; }
      }
      wake();
    }
    function release() { if (grabbed < 0) return; grabbed = -1; wake(); }
    function sleep() { awake = false; accumulator = 0; previous.set(positions); }
    function advance(elapsed) {
      if (!awake || !Number.isFinite(elapsed) || elapsed <= 0) return false;
      accumulator = Math.min(accumulator + elapsed, STEP * 4);
      let changed = false;
      while (accumulator >= STEP) {
        step(); accumulator -= STEP; changed = true;
        if (grabbed < 0) {
          age += STEP;
          let energy = 0;
          for (let p = 0; p < positions.length; p++) energy += (positions[p] - previous[p]) ** 2;
          quiet = energy / count < .00000008 ? quiet + STEP : 0;
          // Residual solver motion in a tall portrait mesh must not keep an
          // otherwise settled preview rendering indefinitely after release.
          if (quiet > .6 || age >= MAX_SETTLE_SECONDS) { sleep(); break; }
        }
      }
      return changed;
    }
    for (let i = 0; i < 160; i++) step();
    sleep();
    return { nx, ny, width: WIDTH, height, positions, rest, thickness, advance, release, sleep,
      get active() { return awake; }, get grabbed() { return grabbed; },
      grab(i) {
        if (!Number.isInteger(i) || i < 0 || i >= count || !inverseMass[i]) return false;
        grabbed = i; move(Array.from(positions.subarray(i * 3, i * 3 + 3))); return true;
      }, move,
    };
  }

  let fiberData;
  function fibers(THREE, model) {
    if (!fiberData) {
      let seed = 1729;
      const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      const coarse = new Float32Array(64 * 64); for (let i = 0; i < coarse.length; i++) coarse[i] = random();
      const bump = new Uint8Array(512 * 512 * 4), roughness = new Uint8Array(bump.length);
      for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
        const p = (y * 512 + x) * 4, ix = x >> 3, iy = y >> 3, fx = x % 8 / 8, fy = y % 8 / 8;
        const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
        const a = coarse[iy * 64 + ix], b = coarse[iy * 64 + (ix + 1) % 64], c = coarse[((iy + 1) % 64) * 64 + ix], d = coarse[((iy + 1) % 64) * 64 + (ix + 1) % 64];
        const clump = (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
        bump[p] = bump[p + 1] = bump[p + 2] = 100 + clump * 65 + random() * 35; bump[p + 3] = 255;
        roughness[p] = roughness[p + 1] = roughness[p + 2] = 235 + clump * 18; roughness[p + 3] = 255;
      }
      fiberData = { bump, roughness };
    }
    const texture = data => {
      const map = new THREE.DataTexture(data, 512, 512, THREE.RGBAFormat);
      map.wrapS = map.wrapT = THREE.RepeatWrapping; map.repeat.set(model.width / 6.7, model.height / 6.7);
      map.magFilter = THREE.LinearFilter; map.minFilter = THREE.LinearMipmapLinearFilter;
      map.generateMipmaps = true; map.needsUpdate = true; return map;
    };
    return { bump: texture(fiberData.bump), roughness: texture(fiberData.roughness) };
  }

  function create(THREE, group, texture, product) {
    const model = product.previewModel, sim = simulate(model), scale = model.width / WIDTH;
    const face = model.face || { x: 0, y: 0, width: 1, height: 1 }, maps = fibers(THREE, model);
    const materials = [texture, null, null].map((map, side) => {
      const material = new THREE.MeshPhysicalMaterial({ color: 0xffffff, map, roughness: side ? .97 : .91,
        metalness: 0, sheen: side ? .8 : .5, sheenColor: 0xffffff, sheenRoughness: .85, specularIntensity: .14,
        bumpMap: maps.bump, bumpScale: side ? .11 : .075, roughnessMap: maps.roughness });
      material.onBeforeCompile = shader => {
        shader.uniforms.wwFace = { value: new THREE.Vector4(face.x, 1 - face.y - face.height, face.width, face.height) };
        shader.uniforms.wwSize = { value: new THREE.Vector2(model.width, model.height) };
        shader.vertexShader = 'varying vec2 wwUv;\n' + shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nwwUv = uv;');
        shader.fragmentShader = 'varying vec2 wwUv;\nuniform vec4 wwFace;\nuniform vec2 wwSize;\n' + shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
          vec2 wwLocal = clamp((wwUv - wwFace.xy) / wwFace.zw, 0.0, 1.0);
          vec2 wwEdge = min(wwLocal, 1.0 - wwLocal) * wwSize;
          float wwSeam = 1.0 - smoothstep(0.025, 0.065, abs(min(wwEdge.x, wwEdge.y) - 0.45));
          float wwStitch = step(0.42, fract(dot(wwLocal * wwSize, vec2(1.0)) / 0.18));
          float wwFiber = texture2D(bumpMap, vBumpMapUv).r;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), 0.012 * wwFiber);
          diffuseColor.rgb *= 1.0 - 0.045 * wwSeam * wwStitch;
        `);
      };
      material.customProgramCacheKey = () => 'blanket-silk-touch-v1';
      return material;
    });
    const rx = sim.nx * 2, ry = sim.ny * 2, count = (rx + 1) * (ry + 1);
    const fineIndex = (x, y) => y * (rx + 1) + x, index = (x, y) => y * (sim.nx + 1) + x;
    const middle = new Float32Array(count * 3), shell = new Float32Array(count * 6), uv = new Float32Array(count * 4);
    const horizontal = new Float32Array((rx + 1) * (sim.ny + 1) * 3), front = [], back = [], edge = [], perimeter = [];
    for (let y = 0; y <= ry; y++) for (let x = 0; x <= rx; x++) {
      const i = fineIndex(x, y);
      uv[i * 2] = uv[(i + count) * 2] = face.x + x / rx * face.width;
      uv[i * 2 + 1] = uv[(i + count) * 2 + 1] = 1 - face.y - y / ry * face.height;
    }
    for (let y = 0; y < ry; y++) for (let x = 0; x < rx; x++) {
      const a = fineIndex(x, y), b = fineIndex(x + 1, y), c = fineIndex(x, y + 1), d = fineIndex(x + 1, y + 1);
      front.push(a, c, b, b, c, d); back.push(a + count, b + count, c + count, b + count, d + count, c + count);
    }
    for (let x = 0; x <= rx; x++) perimeter.push(fineIndex(x, 0));
    for (let y = 1; y <= ry; y++) perimeter.push(fineIndex(rx, y));
    for (let x = rx - 1; x >= 0; x--) perimeter.push(fineIndex(x, ry));
    for (let y = ry - 1; y > 0; y--) perimeter.push(fineIndex(0, y));
    for (let i = 0; i < perimeter.length; i++) { const a = perimeter[i], b = perimeter[(i + 1) % perimeter.length]; edge.push(a, b, b + count, a, b + count, a + count); }
    const midGeometry = new THREE.BufferGeometry(); midGeometry.setAttribute('position', new THREE.BufferAttribute(middle, 3)); midGeometry.setIndex(front);
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(shell, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geometry.setIndex([...front, ...back, ...edge]);
    geometry.addGroup(0, front.length, 0); geometry.addGroup(front.length, back.length, 1); geometry.addGroup(front.length + back.length, edge.length, 2);
    const mesh = new THREE.Mesh(geometry, materials); mesh.name = 'throw-blanket-cloth'; mesh.frustumCulled = false; group.add(mesh);
    let minY = Infinity, maxY = -Infinity;
    for (let p = 1; p < sim.positions.length; p += 3) { minY = Math.min(minY, sim.positions[p]); maxY = Math.max(maxY, sim.positions[p]); }
    const centerY = -(minY + maxY) / 2;
    const point = new THREE.Vector3();
    let disposed = false, demonstration = null;

    function sync() {
      const positions = sim.positions;
      for (let y = 0; y <= sim.ny; y++) for (let x = 0; x <= rx; x++) {
        const cx = Math.floor(x / 2), out = (y * (rx + 1) + x) * 3;
        for (let k = 0; k < 3; k++) {
          const b = positions[index(cx, y) * 3 + k];
          horizontal[out + k] = x % 2 === 0 ? b : (-positions[index(Math.max(0, cx - 1), y) * 3 + k] + 9 * b + 9 * positions[index(Math.min(sim.nx, cx + 1), y) * 3 + k] - positions[index(Math.min(sim.nx, cx + 2), y) * 3 + k]) / 16;
        }
      }
      for (let y = 0; y <= ry; y++) for (let x = 0; x <= rx; x++) {
        const cy = Math.floor(y / 2), out = fineIndex(x, y) * 3;
        for (let k = 0; k < 3; k++) {
          const b = horizontal[(cy * (rx + 1) + x) * 3 + k];
          middle[out + k] = y % 2 === 0 ? b : (-horizontal[(Math.max(0, cy - 1) * (rx + 1) + x) * 3 + k] + 9 * b + 9 * horizontal[(Math.min(sim.ny, cy + 1) * (rx + 1) + x) * 3 + k] - horizontal[(Math.min(sim.ny, cy + 2) * (rx + 1) + x) * 3 + k]) / 16;
        }
      }
      midGeometry.computeVertexNormals(); const normals = midGeometry.attributes.normal.array;
      for (let i = 0; i < count; i++) {
        const x = i % (rx + 1), y = Math.floor(i / (rx + 1)), outside = Math.min(x, rx - x, y, ry - y) === 0;
        const half = sim.thickness * (outside ? .55 : .5);
        for (let k = 0; k < 3; k++) {
          const p = i * 3 + k, center = middle[p] + (k === 1 ? centerY : 0);
          shell[p] = (center + normals[p] * half) * scale; shell[(i + count) * 3 + k] = (center - normals[p] * half) * scale;
        }
      }
      geometry.attributes.position.needsUpdate = true; geometry.computeVertexNormals(); geometry.computeBoundingSphere(); geometry.computeBoundingBox();
    }
    sync();

    return { mesh, simulation: sim,
      get active() { return !disposed && sim.active; },
      beginGrab(hit) {
        if (disposed || hit?.object !== mesh) return false;
        demonstration = null;
        const i = hit.face.a % count;
        return sim.grab(index(Math.round(i % (rx + 1) / 2), Math.round(Math.floor(i / (rx + 1)) / 2)));
      },
      moveGrab(worldPoint) {
        if (disposed) return;
        mesh.worldToLocal(point.copy(worldPoint)); sim.move([point.x / scale, point.y / scale - centerY, point.z / scale]);
      },
      release() { demonstration = null; sim.release(); },
      demonstrate() {
        if (disposed) return;
        const i = index(Math.round(sim.nx * .8), Math.round(sim.ny * .73)); sim.grab(i);
        demonstration = { time: 0, from: Array.from(sim.positions.subarray(i * 3, i * 3 + 3)) };
      },
      advance(elapsed) {
        if (disposed) return false;
        if (demonstration) {
          demonstration.time += Math.min(.04, elapsed);
          const { time, from } = demonstration;
          if (time < 2.8) {
            const lift = Math.sin(Math.min(1, time / 1.4) * Math.PI / 2);
            sim.move([from[0] - .75 * lift, from[1] + sim.height * .47 * lift, from[2] + .9 * lift]);
          } else { demonstration = null; sim.release(); }
        }
        const changed = sim.advance(elapsed); if (changed) sync(); return changed;
      },
      dispose() {
        if (disposed) return; disposed = true; demonstration = null; sim.release(); sim.sleep();
        group.remove(mesh); geometry.dispose(); midGeometry.dispose(); materials.forEach(material => material.dispose());
        maps.bump.dispose(); maps.roughness.dispose();
      },
    };
  }
  return Object.freeze({ create, simulate, STEP });
});
