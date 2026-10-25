(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Product3DGeometry = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  function bag(THREE, group, texture, product) {
    const model = product.previewModel, organic = model.style === 'organic';
    const { width, height, depth } = model;
    const rise = organic ? 19.5 : 20.5, centreY = -rise / 2;
    const colour = model.color || '#ffffff';
    // A small, deterministic woven height field. It is preview-only and owns
    // no image downloads, canvas artwork or manufacturing coordinates.
    const data = new Uint8Array(128 * 128 * 4), yarn = new Uint8Array(data.length);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      const warp = Math.cos(x * Math.PI / 4), weft = Math.cos(y * Math.PI / 4);
      const twill = organic ? Math.sin((x + y) * Math.PI / 8) * 13 : 0;
      const value = Math.round(128 + 35 * warp + 27 * weft + twill);
      const i = (y * 128 + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255;
      yarn[i] = yarn[i + 1] = yarn[i + 2] = Math.round(247 + (value - 128) * .10); yarn[i + 3] = 255;
    }
    const weave = new THREE.DataTexture(data, 128, 128);
    weave.wrapS = weave.wrapT = THREE.RepeatWrapping;
    weave.magFilter = THREE.LinearFilter; weave.minFilter = THREE.LinearMipmapLinearFilter;
    weave.generateMipmaps = true; weave.repeat.set(14, 14); weave.needsUpdate = true;
    const yarnColour = new THREE.DataTexture(yarn, 128, 128);
    yarnColour.wrapS = yarnColour.wrapT = THREE.RepeatWrapping;
    yarnColour.magFilter = THREE.LinearFilter; yarnColour.minFilter = THREE.LinearMipmapLinearFilter;
    yarnColour.generateMipmaps = true; yarnColour.colorSpace = THREE.SRGBColorSpace;
    yarnColour.repeat.copy(weave.repeat); yarnColour.needsUpdate = true;
    let disposed = false;
    function cloth(color, map = null) {
      const surface = new THREE.MeshStandardMaterial({ color, map, roughness: .96,
        bumpMap: weave, bumpScale: organic ? .022 : .015, vertexColors: true, side: THREE.DoubleSide });
      // Materials already belong to the viewer's disposal traversal. Share one
      // weave per bag and release it once when those materials are destroyed.
      surface.addEventListener('dispose', () => { if (!disposed) { disposed = true; weave.dispose(); yarnColour.dispose(); } });
      return surface;
    }
    const fabric = cloth(colour), print = cloth('#ffffff', texture);
    const handles = cloth(model.handleColor, yarnColour);
    const lining = cloth(colour);
    const stitchColour = new THREE.Color(organic ? colour : '#d5d2ca').multiplyScalar(organic ? .72 : .9);
    const seamMaterial = new THREE.MeshStandardMaterial({ color: stitchColour, roughness: 1 });
    const stitchPoints = [], handleStitchPoints = [];
    function add(geometry, material, name) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = name; mesh.position.y = centreY;
      group.add(mesh); return mesh;
    }
    function grid(nx, ny, sample, material, name, reverse = false) {
      const positions = [], uvs = [], colours = [], indices = [];
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        const u = i / nx, v = j / ny, p = sample(u, v);
        positions.push(p.x, p.y, p.z); uvs.push(...(p.uv || [u, v]));
        const shade = p.shade ?? 1; colours.push(shade, shade, shade);
      }
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        indices.push(...(reverse ? [a, c, b, b, c, d] : [a, b, c, b, d, c]));
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
      geometry.setIndex(indices); geometry.computeVertexNormals();
      return add(geometry, material, name);
    }
    function gaussian(value, centre, spread) { return Math.exp(-(((value - centre) / spread) ** 2)); }
    function face(side, u, v) {
      const x0 = (u - .5) * width, y0 = (v - .5) * height;
      const edge = Math.abs(u * 2 - 1);
      const bottom = Math.max(0, 1 - v / .15);
      const taper = organic ? 1 - .17 * bottom * bottom : .97 + .03 * Math.sin(v * Math.PI / 2);
      const x = x0 * taper;
      const topSag = (-.38 * (1 - edge * edge) + .10 * Math.sin(u * Math.PI * 5)) * v ** 12;
      const y = y0 + topSag + .28 * (1 - edge * edge) * (1 - v) ** 12;
      const sideDepth = depth / 2 * (.87 - .52 * v ** 4);
      const fullness = (organic ? .5 : .8) * Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
      // Shallow tension folds fan out from the handle anchors. Edge creases
      // and the boxed bottom remain real geometry when seen from the side.
      const anchors = gaussian(u, .19 + (1 - v) * .07, .032) + gaussian(u, .81 - (1 - v) * .07, .032);
      const folds = -.8 * anchors * v ** 3 + .34 * Math.sin(u * 24 + v * 3) * edge ** 3 * Math.sin(v * Math.PI)
        + .20 * Math.sin(u * Math.PI * 6 + .8) * Math.sin(v * Math.PI);
      const bottomFold = -.22 * gaussian(v, .065, .035) * Math.sin(Math.PI * u)
        - .38 * gaussian(v, .04 + .16 * (1 - edge), .03) * edge ** 3;
      const z = side * (sideDepth + fullness + folds + bottomFold - (organic ? .8 : .5) * edge ** 6);
      const shade = .98 - .055 * edge ** 5 - .045 * anchors * v ** 3 - .06 * gaussian(v, .035, .035);
      return { x, y, z, shade, uv: [1 / 17 + (side === 1 ? u : 1 - u) * 15 / 17,
        .75 / 16.5 + v * 15 / 16.5] };
    }
    for (const side of [1, -1]) {
      grid(72, 72, (u, v) => face(side, u, v), organic ? fabric : print,
        side === 1 ? 'bag-front' : 'bag-back', side === -1);
      grid(48, 48, (u, v) => {
        const p = face(side, u, v); p.z -= side * .12;
        p.shade = .48 + .25 * v; return p;
      }, lining, side === 1 ? 'bag-inner-front' : 'bag-inner-back', side === 1);
      grid(72, 4, (u, v) => {
        const p = face(side, u, 1 - (1 - v) * (organic ? 2.2 : .9) / height);
        p.z += side * .035; p.shade *= .965; return p;
      }, organic ? fabric : print, `bag-top-hem-${side}`, side === -1);
    }
    for (const edge of [0, 1]) for (const side of [1, -1]) {
      grid(8, 64, (u, v) => {
        const p = face(side, edge, v), frontU = side === 1 ? edge : 1 - edge;
        return { x: p.x - Math.sign(p.x) * Math.sin((u / 2 + .5) * Math.PI) * (organic ? .65 : .22),
          y: p.y, z: p.z * u, shade: .87 - .12 * (1 - u),
          uv: [1 / 17 + frontU * 15 / 17 + (frontU ? 1 : -1) * (1 - u) / 17,
            .75 / 16.5 + v * 15 / 16.5] };
      }, organic ? fabric : print, `bag-side-${edge}-${side}`, (edge === 1) === (side === 1));
    }
    grid(64, 16, (u, v) => {
      const front = face(1, u, 0), back = face(-1, u, 0);
      return { x: front.x, y: front.y + .06 * Math.sin(v * Math.PI), z: back.z + (front.z - back.z) * v, shade: .87 };
    }, fabric, 'bag-base', true);
    if (organic) {
      // File 5 is a 25.4 cm square, not an all-over texture. Subdivide the
      // print patch on the same cotton surface; the rest and rear stay blank.
      grid(64, 64, (u, v) => {
        const x = (u - .5) * model.printWidth;
        const y = (v - .5) * model.printHeight + model.printFaceCenterY;
        const p = face(1, x / width + .5, y / height + .5);
        return { ...p, z: p.z + .018, uv: [u, v] };
      }, print, 'bag-front-print');
    }
    function tube(points, radius, name) {
      const curve = new THREE.CatmullRomCurve3(points);
      add(new THREE.TubeGeometry(curve, Math.max(24, points.length * 2), radius, 5, false), seamMaterial, name);
    }
    function stitches(points, spacing = .35, target = stitchPoints) {
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i], length = a.distanceTo(b);
        const count = Math.max(1, Math.ceil(length / spacing));
        for (let j = 0; j < count; j++) {
          const start = a.clone().lerp(b, j / count), end = a.clone().lerp(b, (j + .56) / count);
          target.push(start.x, start.y, start.z, end.x, end.y, end.z);
        }
      }
    }
    for (const side of [1, -1]) {
      const rim = [], hem = [];
      for (let i = 0; i <= 96; i++) {
        const p = face(side, i / 96, 1), q = face(side, i / 96, 1 - (organic ? 2.2 : .9) / height);
        rim.push(new THREE.Vector3(p.x, p.y, p.z));
        hem.push(new THREE.Vector3(q.x, q.y, q.z + side * .025));
      }
      tube(rim, .085, `bag-rim-${side}`); stitches(hem);
      for (const edge of [.015, .985]) {
        const seam = [];
        for (let i = 0; i <= 72; i++) { const p = face(side, edge, i / 72); seam.push(new THREE.Vector3(p.x, p.y, p.z + side * .025)); }
        stitches(seam);
      }
    }
    const a = organic ? 10.2 : 12.4, top = height / 2;
    for (const side of [1, -1]) {
      const z = face(side, .2, 1).z + side * .16;
      const path = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-a, top - 3, z), new THREE.Vector3(-a - .25, top + 4, z + side * .18),
        new THREE.Vector3(-a - .3, top + rise - 3, z + side * .9),
        new THREE.Vector3(-a + 2, top + rise, z + side * .6),
        new THREE.Vector3(0, top + rise + .15, z + side * .15),
        new THREE.Vector3(a - 2, top + rise, z - side * .1),
        new THREE.Vector3(a + .3, top + rise - 3, z), new THREE.Vector3(a + .25, top + 4, z),
        new THREE.Vector3(a, top - 3, z),
      ], false, 'catmullrom', .18);
      const half = 1.25, thick = organic ? .06 : .10;
      const positions = [], uvs = [], colours = [], indices = [], edges = [[], []];
      for (let i = 0; i <= 144; i++) {
        const t = i / 144, p = path.getPoint(t), tangent = path.getTangent(t);
        const across = new THREE.Vector3(tangent.y, -tangent.x, 0).normalize();
        for (const [w, d] of [[-half, thick], [half, thick], [-half, -thick], [half, -thick]]) {
          const q = p.clone().addScaledVector(across, w); q.z += d;
          positions.push(q.x, q.y, q.z); uvs.push(w / 2.5 + .5, t * 3); colours.push(.96, .96, .96);
        }
        for (let edge = 0; edge < 2; edge++) {
          const q = p.clone().addScaledVector(across, (edge ? 1 : -1) * (half - .18)); q.z += side * (thick + .025);
          edges[edge].push(q);
        }
        if (i < 144) {
          const k = i * 4;
          for (const [a0, b0] of [[0, 1], [1, 3], [3, 2], [2, 0]]) indices.push(k + a0, k + b0, k + a0 + 4, k + b0, k + b0 + 4, k + a0 + 4);
        }
      }
      indices.push(0, 2, 1, 1, 2, 3, 576, 577, 578, 577, 579, 578);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
      geometry.setIndex(indices); geometry.computeVertexNormals();
      add(geometry, handles, `bag-handle-${side}`);
      edges.forEach(points => stitches(points, .35, handleStitchPoints));
      for (const x of [-a, a]) {
        const points = [[x - 1, top - 2.8], [x + 1, top - 2.8], [x + 1, top - .7], [x - 1, top - .7], [x - 1, top - 2.8], [x + 1, top - .7], [x - 1, top - .7], [x + 1, top - 2.8]]
          .map(([x, y]) => new THREE.Vector3(x, y, z + side * (thick + .03)));
        stitches(points, .22, handleStitchPoints);
      }
    }
    for (const [points, color, name] of [[stitchPoints, stitchColour, 'bag-stitching'],
      [handleStitchPoints, new THREE.Color(model.handleColor).multiplyScalar(organic ? .8 : 1.15), 'bag-strap-stitching']]) {
      const thread = new THREE.BufferGeometry();
      thread.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
      const threadMesh = new THREE.LineSegments(thread, new THREE.LineBasicMaterial({ color, transparent: true, opacity: .45 }));
      threadMesh.name = name; threadMesh.position.y = centreY; group.add(threadMesh);
    }
  }
  // All lengths are centimetres. Artwork UVs are in the provider's complete
  // print file; neither safe-area padding nor the camera opening stretches it.
  function build(THREE, group, texture, product, backTexture) {
    const model = product.previewModel;
    if (model.kind === 'tote') { bag(THREE, group, texture, product); return; }
    if (model.kind === 'blanket') {
      const cloth = typeof module === 'object' && module.exports ? require('./blanket-cloth') : root.BlanketCloth;
      return cloth.create(THREE, group, texture, product);
    }
    const material = (color, roughness = .42, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
    const add = (geometry, surface, position) => {
      const mesh = new THREE.Mesh(geometry, surface);
      if (position) mesh.position.set(...position);
      group.add(mesh);
      return mesh;
    };
    const bodyColor = model.color || '#ffffff';
    const plain = material(bodyColor);
    const ink = new THREE.MeshStandardMaterial({ map: texture, roughness: model.finish === 'glossy' ? .18 : .63, metalness: .02 });
    const metal = material('#b9bec2', .24, .85);
    function ring(radius, tube, y, surface) {
      const mesh = add(new THREE.TorusGeometry(radius, tube, 16, 96), surface, [0, y, 0]);
      mesh.rotation.x = Math.PI / 2;
    }
    function lid(radius, height, y, surface) {
      add(new THREE.CylinderGeometry(radius, radius, height, 96), surface, [0, y, 0]);
    }
    function handle(radius, top, bottom, surface, tube = .28) {
      const path = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-radius + .1, top, 0), new THREE.Vector3(-radius - 1.8, top, 0),
        new THREE.Vector3(-radius - 2.5, (top + bottom) / 2, 0),
        new THREE.Vector3(-radius - 1.8, bottom, 0), new THREE.Vector3(-radius + .1, bottom, 0),
      ]);
      add(new THREE.TubeGeometry(path, 72, tube, 16, false), surface);
    }
    function roundRect(x, y, w, h, r) {
      const shape = new THREE.Shape();
      shape.moveTo(x + r, y); shape.lineTo(x + w - r, y);
      shape.quadraticCurveTo(x + w, y, x + w, y + r); shape.lineTo(x + w, y + h - r);
      shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h); shape.lineTo(x + r, y + h);
      shape.quadraticCurveTo(x, y + h, x, y + h - r); shape.lineTo(x, y + r);
      shape.quadraticCurveTo(x, y, x + r, y); return shape;
    }
    function surfaceGrid(nx, ny, sample, surface, name, reverse = false, omit = null) {
      const positions = [], uvs = [], indices = [];
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        const p = sample(i / nx, j / ny);
        positions.push(p.x, p.y, p.z); uvs.push(...(p.uv || [i / nx, j / ny]));
      }
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        if (omit?.((i + .5) / nx, (j + .5) / ny)) continue;
        const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        indices.push(...(reverse ? [a, c, b, b, c, d] : [a, b, c, b, d, c]));
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices); geometry.computeVertexNormals();
      const mesh = add(geometry, surface); mesh.name = name; return mesh;
    }
    function facingMaterials(geometry, choose) {
      // Every ExtrudeGeometry triangle is non-indexed. Partition consecutive
      // runs so cap ownership is explicit without adding coincident covers.
      const p = geometry.getAttribute('position'), n = geometry.getAttribute('normal');
      geometry.clearGroups();
      for (let i = 0; i < p.count; i += 3) {
        const index = choose(i, p, n), previous = geometry.groups.at(-1);
        if (previous?.materialIndex === index) previous.count += 3;
        else geometry.addGroup(i, 3, index);
      }
    }
    if (model.kind === 'sleeve') {
      const { width, height, depth } = model, radius = model.radius || 1.8;
      const field = new Uint8Array(128 * 128 * 4);
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
        const i = (y * 128 + x) * 4;
        const grain = 128 + 24 * Math.sin(x * 2.4) * Math.cos(y * 2.1) + ((x * 17 + y * 37) % 23) - 11;
        field[i] = field[i + 1] = field[i + 2] = grain; field[i + 3] = 255;
      }
      const pores = new THREE.DataTexture(field, 128, 128);
      pores.wrapS = pores.wrapT = THREE.RepeatWrapping;
      pores.repeat.set(9, 7); pores.generateMipmaps = true;
      pores.minFilter = THREE.LinearMipmapLinearFilter; pores.magFilter = THREE.LinearFilter; pores.needsUpdate = true;
      let disposed = false;
      const cloth = (color, map = null) => {
        const m = new THREE.MeshStandardMaterial({ color, map, roughness: .94, bumpMap: pores, bumpScale: .016 });
        m.addEventListener('dispose', () => { if (!disposed) { disposed = true; pores.dispose(); } }); return m;
      };
      const front = cloth('#ffffff', texture), back = cloth('#191b1e'), binding = cloth('#17191c');
      const face = model.face;
      for (const side of [1, -1]) {
        const skin = surfaceGrid(96, 72, (u, v) => {
          const y = (v - .5) * height;
          const cornerY = Math.max(0, Math.abs(y) - height / 2 + radius);
          const half = width / 2 - radius + Math.sqrt(Math.max(0, radius * radius - cornerY * cornerY));
          const x = (u * 2 - 1) * half;
          const edge = Math.max(0, Math.min(half - Math.abs(x), height / 2 - Math.abs(y)));
          const loft = .075 + (depth / 2 - .075) * (1 - Math.exp(-edge / .65));
          const tension = .025 * Math.sin(x * .55) * Math.sin(y * .33) * Math.exp(-edge / 2);
          return { x, y, z: side * (loft + tension), uv: [face.x + (x / width + .5) * face.width,
            1 - face.y - (.5 - y / height) * face.height] };
        }, side === 1 ? [front, binding] : back, side === 1 ? 'sleeve-front' : 'sleeve-back', side === -1);
        if (side === 1) {
          const geometry = skin.geometry, index = geometry.index, p = geometry.getAttribute('position');
          for (let i = 0; i < index.count; i += 3) {
            const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
            const edge = ids.some(id => {
              const x = Math.abs(p.getX(id)) - width / 2 + radius, y = Math.abs(p.getY(id)) - height / 2 + radius;
              return Math.min(Math.max(x, y), 0) + Math.hypot(Math.max(x, 0), Math.max(y, 0)) > radius - .28;
            });
            const materialIndex = edge ? 1 : 0, previous = geometry.groups.at(-1);
            if (previous?.materialIndex === materialIndex) previous.count += 3;
            else geometry.addGroup(i, 3, materialIndex);
          }
        }
      }
      const outline = roundRect(-width / 2, -height / 2, width, height, radius);
      const points = outline.getSpacedPoints(240).slice(0, -1);
      surfaceGrid(240, 8, (u, v) => {
        const p = points[Math.round(u * 240) % 240];
        return { x: p.x, y: p.y, z: (v - .5) * .15 };
      }, binding, 'sleeve-edge');
      const path = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(p.x, p.y, 0)), true);
      const hem = add(new THREE.TubeGeometry(path, 320, .14, 10, true), binding); hem.name = 'sleeve-padded-binding';
      // Two zipper tracks follow the upper/side enclosure. The lower binding
      // stays continuous and soft, as on the provider's close-up photographs.
      const zipperPoints = points.filter(p => p.y > 0 || p.x > width / 2 - .3);
      const zipPath = new THREE.CatmullRomCurve3(zipperPoints.map(p => new THREE.Vector3(p.x, p.y, -.025)));
      const teethMaterial = material('#3b3d40', .68);
      add(new THREE.TubeGeometry(zipPath, 220, .055, 6, false), teethMaterial).name = 'sleeve-zipper-track';
      const teethGeometry = new THREE.BoxGeometry(.065, .065, .08);
      const teeth = new THREE.InstancedMesh(teethGeometry, teethMaterial, 220), transform = new THREE.Object3D();
      for (let i = 0; i < 220; i++) {
        const t = i / 219, p = zipPath.getPoint(t), tangent = zipPath.getTangent(t);
        transform.position.copy(p); transform.rotation.z = Math.atan2(tangent.y, tangent.x);
        transform.updateMatrix(); teeth.setMatrixAt(i, transform.matrix);
      }
      teeth.name = 'sleeve-zipper-teeth'; group.add(teeth);
      for (const [index, y] of [[0, height * .16], [1, height * .16 - .72]]) {
        const slider = add(new THREE.BoxGeometry(.38, .55, .28), material('#292b2e', .42), [width / 2 + .03, y, 0]);
        slider.name = `sleeve-zipper-slider-${index}`;
        const pull = roundRect(-.22, -.82, .44, 1.64, .15);
        pull.holes.push(new THREE.Path(roundRect(-.10, .30, .20, .28, .07).getPoints(16)));
        const geometry = new THREE.ExtrudeGeometry(pull, { depth: .085, bevelEnabled: true, bevelSize: .035, bevelThickness: .025, bevelSegments: 3, curveSegments: 12 });
        geometry.translate(0, 0, -.04);
        const tab = add(geometry, material('#15171a', .48), [width / 2 + .29 + index * .35, y - .77, .20]);
        tab.rotation.z = index ? .24 : -.12; tab.rotation.y = index ? -.16 : .14;
        tab.name = `sleeve-zipper-pull-${index}`;
      }
      return;
    }
    if (model.kind === 'pillow') {
      for (const side of [1, -1]) {
        const geometry = new THREE.PlaneGeometry(model.width, model.height, 48, 48);
        const positions = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
        for (let i = 0; i < positions.count; i++) {
          const x = positions.getX(i), y = positions.getY(i);
          const fullness = Math.pow(Math.max(0, 1 - (x * 2 / model.width) ** 2) * Math.max(0, 1 - (y * 2 / model.height) ** 2), .65);
          positions.setZ(i, side * (.12 + fullness * model.depth / 2));
          uv.setXY(i, model.face.x + (side * x / model.width + .5) * model.face.width,
            1 - model.face.y - (.5 - y / model.height) * model.face.height);
        }
        geometry.computeVertexNormals();
        const surface = new THREE.MeshStandardMaterial({ map: side === 1 ? texture : backTexture, roughness: .95, side: side === 1 ? THREE.FrontSide : THREE.BackSide });
        add(geometry, surface);
      }
      return;
    }
    if (model.kind === 'case') {
      const { width, height, depth, face, camera } = model;
      const samsung = /Samsung/.test(model.device || product.size?.label || '');
      const later = /17|26/.test(model.device || product.size?.label || '');
      const radius = samsung ? .64 : 1.10, frontZ = depth / 2;
      const liner = material('#202226', .8), lipMaterial = material('#282a2d', .6);
      const outline = roundRect(-width / 2, -height / 2, width, height, radius);
      const cameraPoints = model.cameraPath
        ? model.cameraPath.map(([x, y]) => new THREE.Vector2(x, y))
        : roundRect(camera.x, camera.y, camera.width, camera.height, camera.radius).getPoints(64);
      const plate = roundRect(-width / 2, -height / 2, width, height, radius);
      plate.holes.push(new THREE.Path(cameraPoints));
      function printUV(geometry, wrap = false) {
        const p = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i), y = p.getY(i), fold = Math.max(0, frontZ - p.getZ(i));
          let u = face.x + (x / width + .5) * face.width;
          let v = 1 - face.y - (.5 - y / height) * face.height;
          if (wrap) {
            if (Math.abs(x) > width / 2 - radius) u += Math.sign(x) * fold / width * face.width;
            if (Math.abs(y) > height / 2 - radius) v += Math.sign(y) * fold / height * face.height;
          }
          uv.setXY(i, u, v);
        }
      }
      const plateGeometry = new THREE.ExtrudeGeometry(plate, { depth: .14, bevelEnabled: true,
        bevelSize: .045, bevelThickness: .045, bevelSegments: 4, curveSegments: 28 });
      plateGeometry.translate(0, 0, frontZ - .14);
      printUV(plateGeometry);
      facingMaterials(plateGeometry, (i, p, n) => n.getZ(i) < -.5 ? 1 : 0);
      const shell = add(plateGeometry, [ink, liner]); shell.name = 'case-printed-shell'; shell.userData.printFace = face;
      const outer = outline.getSpacedPoints(256).slice(0, -1);
      const innerShape = roundRect(-width / 2 + .18, -height / 2 + .18, width - .36, height - .36, radius - .18);
      const inner = innerShape.getSpacedPoints(256).slice(0, -1);
      function portAt(p, z) {
        return p.y < -height / 2 + .23 && Math.abs(z + .16) < .18 &&
          (Math.abs(p.x) < .69 || Math.abs(Math.abs(p.x) - 1.65) < .46);
      }
      for (const inside of [false, true]) {
        const points = inside ? inner : outer;
        const wall = surfaceGrid(256, 20, (u, v) => {
          const p = points[Math.round(u * 256) % 256], z = -.45 + v * (frontZ + .31);
          return { x: p.x, y: p.y, z };
        }, inside ? liner : ink, inside ? 'case-inner-wall' : 'case-outer-wall', inside,
        (u, v) => portAt(points[Math.floor(u * 256) % 256], -.45 + v * (frontZ + .31)));
        printUV(wall.geometry, !inside);
      }
      const rimShape = roundRect(-width / 2, -height / 2, width, height, radius);
      rimShape.holes.push(new THREE.Path(innerShape.getPoints(48)));
      const rim = add(new THREE.ShapeGeometry(rimShape, 28), liner, [0, 0, -.45]);
      rim.rotation.y = Math.PI; rim.name = 'case-front-lip';
      // A black charging-port tunnel joins the two wall surfaces. It remains
      // an actual opening in the case, including when the phone is omitted.
      for (const x of [-.71, .71]) add(new THREE.BoxGeometry(.06, .20, .40), liner, [x, -height / 2 + .09, -.16]).name = 'case-port-jamb';
      for (const z of [-.36, .04]) add(new THREE.BoxGeometry(1.46, .20, .045), liner, [0, -height / 2 + .09, z]).name = 'case-port-jamb';
      function offsetPolygon(points, distance) {
        const area = THREE.ShapeUtils.area(points), sign = area > 0 ? 1 : -1;
        return points.map((p, i) => {
          const previous = points[(i + points.length - 1) % points.length], next = points[(i + 1) % points.length];
          const tangent = next.clone().sub(previous).normalize();
          return p.clone().add(new THREE.Vector2(tangent.y, -tangent.x).multiplyScalar(distance * sign));
        });
      }
      const rimOutline = offsetPolygon(cameraPoints, .095);
      const cameraRim = new THREE.Shape(rimOutline); cameraRim.holes.push(new THREE.Path(cameraPoints));
      const cameraGeometry = new THREE.ExtrudeGeometry(cameraRim, { depth: .12, bevelEnabled: true,
        bevelSize: .02, bevelThickness: .02, bevelSegments: 3, curveSegments: 20 });
      cameraGeometry.translate(0, 0, frontZ + .025);
      add(cameraGeometry, lipMaterial).name = 'case-camera-rim';
      for (const [side, y, length] of samsung ? [[1, 4.5, 1.45], [1, 2.5, 1.0]]
        : [[-1, 5.1, .65], [-1, 3.7, 1.0], [-1, 2.1, 1.0], [1, 3.6, 1.35], [1, -.3, 1.3]]) {
        const button = roundRect(-.17, -length / 2, .34, length, .13);
        const geometry = new THREE.ExtrudeGeometry(button, { depth: .11, bevelEnabled: true,
          bevelSize: .025, bevelThickness: .025, bevelSegments: 3, curveSegments: 12 });
        const mesh = add(geometry, lipMaterial, [side * (width / 2 - .015), y, -.14]);
        mesh.rotation.y = side * Math.PI / 2; mesh.name = 'case-button';
      }
      if (model.magSafe) {
        // The reference moulding is a shallow exterior relief, not a silver
        // circle painted on the phone-facing liner. Retain the print under it.
        const ringRadius = Math.min(2.45, width * .29), ringY = -.70;
        const relief = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .66, map: texture });
        const ringGeometry = new THREE.TorusGeometry(ringRadius, .06, 12, 112);
        ringGeometry.translate(0, ringY, frontZ + .075); printUV(ringGeometry);
        add(ringGeometry, relief).name = 'case-magsafe-relief';
        const alignment = new THREE.ExtrudeGeometry(roundRect(-.20, ringY - ringRadius - 1.15, .40, .95, .19), {
          depth: .06, bevelEnabled: true, bevelSize: .035, bevelThickness: .035, bevelSegments: 3, curveSegments: 20 });
        alignment.translate(0, 0, frontZ + .055); printUV(alignment);
        add(alignment, relief).name = 'case-magsafe-alignment';
      }
      if (model.displayPhone) {
        // The removable display handset matches the provider's installed-phone
        // photos. It is a separate preview accessory and never a print surface.
        const phone = new THREE.Group(); phone.name = 'display-phone'; phone.userData.previewAccessory = true; group.add(phone);
        function accessory(geometry, surface, position, name) {
          const mesh = new THREE.Mesh(geometry, surface); if (position) mesh.position.set(...position);
          mesh.name = name; mesh.userData.previewAccessory = true; phone.add(mesh); return mesh;
        }
        const phoneShape = roundRect(-width / 2 + .20, -height / 2 + .20, width - .40, height - .40, radius - .17);
        const handset = new THREE.ExtrudeGeometry(phoneShape, { depth: depth - .27, bevelEnabled: true,
          bevelSize: .035, bevelThickness: .035, bevelSegments: 3, curveSegments: 24 });
        handset.translate(0, 0, -depth / 2 + .09);
        accessory(handset, material('#25282c', .28, .45), null, 'display-phone-body');
        const screen = accessory(new THREE.ShapeGeometry(phoneShape, 28), material('#111419', .12, .18), [0, 0, -depth / 2 + .045], 'display-phone-screen');
        screen.rotation.y = Math.PI;
        const islandPoints = offsetPolygon(cameraPoints, -.11);
        const island = new THREE.ExtrudeGeometry(new THREE.Shape(islandPoints), { depth: .12, bevelEnabled: true,
          bevelSize: .035, bevelThickness: .035, bevelSegments: 3, curveSegments: 24 });
        island.translate(0, 0, frontZ - .005);
        accessory(island, material('#303237', .32, .25), null, 'display-phone-camera-island');
        const x = camera.x, y = camera.y, w = camera.width, h = camera.height;
        const lenses = samsung
          ? [[x + w * .27, y + h * .17, w * .19], [x + w * .27, y + h * .50, w * .19], [x + w * .27, y + h * .82, w * .19],
            [x + w * .76, y + h * .79, w * .115], [x + w * .76, y + h * .45, w * .115]]
          : later ? [[x + w * .18, y + h * .25, h * .19], [x + w * .18, y + h * .75, h * .19], [x + w * .47, y + h * .50, h * .19]]
          : [[x + w * .26, y + h * .24, w * .185], [x + w * .26, y + h * .76, w * .185], [x + w * .73, y + h * .50, w * .185]];
        const glassPixels = new Uint8Array(64 * 64 * 4);
        for (let py = 0; py < 64; py++) for (let px = 0; px < 64; px++) {
          const u = (px - 31.5) / 32, v = (py - 31.5) / 32, r = Math.hypot(u, v), i = (py * 64 + px) * 4;
          const flare = Math.exp(-(((u + .28) / .09) ** 2 + ((v - .32) / .12) ** 2));
          const coating = Math.exp(-(((r - .48) / .13) ** 2)) * (.5 + .5 * Math.cos(Math.atan2(v, u) - 1.9));
          glassPixels[i] = 7 + 14 * coating + 130 * flare;
          glassPixels[i + 1] = 11 + 29 * coating + 160 * flare;
          glassPixels[i + 2] = 18 + 43 * coating + 185 * flare; glassPixels[i + 3] = 255;
        }
        const lensTexture = new THREE.DataTexture(glassPixels, 64, 64);
        lensTexture.colorSpace = THREE.SRGBColorSpace; lensTexture.magFilter = THREE.LinearFilter; lensTexture.needsUpdate = true;
        const lensGlass = new THREE.MeshStandardMaterial({ map: lensTexture, roughness: .10, metalness: .18 });
        let lensDisposed = false;
        lensGlass.addEventListener('dispose', () => { if (!lensDisposed) { lensDisposed = true; lensTexture.dispose(); } });
        for (const [cx, cy, r] of lenses) {
          const bezel = accessory(new THREE.CylinderGeometry(r, r, .10, 48), material(samsung && later ? '#a1a6ac' : '#555b62', .24, .65), [cx, cy, frontZ + .19], 'display-phone-lens-bezel');
          bezel.rotation.x = Math.PI / 2;
          accessory(new THREE.TorusGeometry(r * .88, .028, 8, 48), material('#7f858c', .18, .8), [cx, cy, frontZ + .243], 'display-phone-lens-rim');
          accessory(new THREE.CircleGeometry(r * .86, 48), lensGlass, [cx, cy, frontZ + .247], 'display-phone-lens');
        }
        const flashX = x + w * (samsung ? .76 : later ? .82 : .75), flashY = y + h * (samsung ? .62 : .85);
        accessory(new THREE.CircleGeometry(.19, 32), material('#dfdccb', .45), [flashX, flashY, frontZ + .249], 'display-phone-flash');
        if (!samsung) accessory(new THREE.CircleGeometry(.22, 32), material('#111419', .8), [flashX, y + h * .20, frontZ + .249], 'display-phone-lidar');
      }
      return;
    }
    if (['canvas', 'panel', 'mousepad'].includes(model.kind)) {
      const { width, height, depth } = model;
      const shape = roundRect(-width / 2, -height / 2, width, height, model.radius || .02);
      const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 20 });
      geometry.translate(0, 0, -depth / 2);
      const face = model.face || { x: 0, y: 0, width: 1, height: 1 };
      const positions = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) {
        const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
        // Side faces of a wrapped canvas continue the artwork past the front
        // fold. Panels/textiles have an unprinted back and edge material.
        let u = face.x + (x / width + .5) * face.width;
        let v = 1 - face.y - (.5 - y / height) * face.height;
        if (model.kind === 'canvas' && z < depth / 2 - .001) {
          const inset = depth / 2 - z;
          if (Math.abs(x) > width / 2 - .001) u += Math.sign(x) * inset / width * face.width;
          if (Math.abs(y) > height / 2 - .001) v += Math.sign(y) * inset / height * face.height;
        }
        uv.setXY(i, u, v);
      }
      const paper = model.kind === 'panel' && !model.frameColor;
      // ExtrudeGeometry groups both caps together. Give the rear cap its own
      // material instead of hiding a second printed cap under a nearby plane.
      // The former 0.01 cm gap quantized to one depth value on large posters.
      facingMaterials(geometry, (i, p, n) => Math.abs(n.getZ(i)) > .5 ? n.getZ(i) < 0 ? 2 : 0 : 1);
      add(geometry, [ink, model.kind === 'canvas' ? ink : material(model.edgeColor || (paper ? '#f4f3ee' : '#202124'), .85),
        material(model.kind === 'canvas' ? '#d7c6a5' : paper ? '#faf9f5' : '#27292b', .85)]);
      if (model.frameColor) {
        const frame = material(model.frameColor, .6);
        for (const side of [-1, 1]) {
          add(new THREE.BoxGeometry(.9, height + 1.8, depth + .25), frame, [side * (width + .9) / 2, 0, .04]);
          add(new THREE.BoxGeometry(width, .9, depth + .25), frame, [0, side * (height + .9) / 2, .04]);
        }
      }
      return;
    }
    const height = product.size.heightCm, radius = product.size.diameterCm / 2;
    const profile = model.profile || [[radius * .96, -height / 2], [radius, height / 2]];
    const points = profile.map(([r, y]) => new THREE.Vector2(r, y));
    const maximumRadius = Math.max(...points.map(point => point.x));
    const smoothProfile = points.length > 3 ? new THREE.SplineCurve(points).getPoints(128).map(point =>
      new THREE.Vector2(Math.max(0, Math.min(maximumRadius, point.x)), Math.max(-height / 2, Math.min(height / 2, point.y)))) : points;
    const geometry = new THREE.LatheGeometry(smoothProfile, 160, -Math.PI / 2);
    const positions = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
    // LatheGeometry normally spreads V evenly over profile points, which
    // distorts text around shoulders. V must follow physical height instead.
    for (let i = 0; i < uv.count; i++) uv.setY(i, positions.getY(i) / height + .5);
    add(geometry, ink);
    lid(profile[0][0], .12, profile[0][1], plain);
    const top = profile[profile.length - 1];
    if (model.kind === 'bottle') {
      const cap = [[top[0] + .08, top[1]], [top[0] + .12, top[1] + .25], [top[0] + .12, top[1] + 1.65], [top[0], top[1] + 2.1], [top[0] * .75, top[1] + 2.4], [top[0] * .35, top[1] + 2.5], [0, top[1] + 2.5]].map(([r,y]) => new THREE.Vector2(r,y));
      add(new THREE.LatheGeometry(cap, 96), metal);
      ring(top[0], .1, top[1], metal);
      ring(radius * .94, .12, -height / 2 + .25, metal);
    } else if (['steel-tumbler', 'wine', 'travel'].includes(model.kind)) {
      const transparent = new THREE.MeshStandardMaterial({ color: '#b9c4c9', transparent: true, opacity: .6, roughness: .15, metalness: .1 });
      lid(top[0] * .98, .35, top[1] + .1, model.kind === 'travel' ? material('#25292c', .4) : transparent);
      ring(top[0] * .98, .09, top[1] + .25, metal);
      if (model.kind === 'steel-tumbler' || model.straw) {
        const strawHeight = model.kind === 'travel' ? 4.5 : 7;
        const straw = add(new THREE.CylinderGeometry(.16, .16, strawHeight, 24), model.kind === 'steel-tumbler' ? metal : plain,
          [radius * .35, top[1] + strawHeight / 2 - .3, 0]); straw.rotation.z = -.08;
      }
      // Reference photos place the white handle above the cup-holder taper.
      if (model.kind === 'travel') handle(radius, height * .39, height * .04, plain, .24);
    } else {
      const interior = material(model.accent || '#f3f3f3');
      interior.side = THREE.BackSide;
      add(new THREE.CylinderGeometry(radius - .14, radius - .28, height - .45, 128, 1, true), interior, [0, .08, 0]);
      ring(radius - .07, .07, top[1], model.kind === 'enamel' ? metal : material(model.accent || '#ffffff', .25));
      add(new THREE.CircleGeometry(radius - .24, 96), material(model.accent || '#eeeeee'), [0, -height / 2 + .35, 0]).rotation.x = -Math.PI / 2;
      handle(radius, height * .34, -height * .34, model.kind === 'enamel' ? plain : material(model.accent || '#ffffff', .28), model.kind === 'enamel' ? .24 : .4);
    }
  }
  return { build };
});
