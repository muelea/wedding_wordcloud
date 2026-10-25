(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PrintfulProductModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const buffers = new Map();
  const MAX_CACHE_BYTES = 10 * 1024 * 1024;
  let loaderModule = null;

  function atlasSizeFor(product, maxTextureSize = 4096) {
    const limit = Math.min(4096, maxTextureSize);
    // Keep the approved mug treatment. Wide wrap files need fewer vertical
    // texels, reducing memory without changing their normalized atlas or UVs.
    if (product.previewMesh.id === 'mug-325') return { width: limit, height: limit };
    const rect = product.previewMesh.front;
    const rotated = product.previewMesh.canvas && product.orientation === 'landscape';
    const aspect = (rotated ? product.printFile.height / product.printFile.width : product.printFile.width / product.printFile.height) * rect[3] / rect[2];
    const edge = value => Math.min(limit, Math.max(1, 2 ** Math.ceil(Math.log2(value))));
    return aspect >= 1 ? { width: limit, height: edge(limit / aspect) } : { width: edge(limit * aspect), height: limit };
  }

  function moduleForLoader() {
    if (!loaderModule) loaderModule = import('/vendor/three/examples/jsm/loaders/GLTFLoader.js?v=0.160.1')
      .catch(error => { loaderModule = null; throw error; });
    return loaderModule;
  }

  function modelBytes(url) {
    if (!/^\/assets\/product-models\/[a-z0-9-]+-[a-f0-9]{16}\.glb$/.test(url)) return Promise.reject(new Error('Invalid local model URL'));
    const cached = buffers.get(url);
    if (cached) { buffers.delete(url); buffers.set(url, cached); return cached.promise; }
    const entry = { bytes: 0 };
    entry.promise = fetch(url).then(response => {
      if (!response.ok) throw new Error(`Model request failed: ${response.status}`);
      return response.arrayBuffer();
    }).then(bytes => {
      entry.bytes = bytes.byteLength;
      let total = [...buffers.values()].reduce((sum, item) => sum + item.bytes, 0);
      for (const [key, item] of buffers) {
        if (total <= MAX_CACHE_BYTES && buffers.size <= 16) break;
        if (item.bytes && item !== entry) { buffers.delete(key); total -= item.bytes; }
      }
      return bytes;
    }).catch(error => { buffers.delete(url); throw error; });
    buffers.set(url, entry);
    return entry.promise;
  }

  async function loadScene(descriptor) {
    const [{ GLTFLoader }, bytes] = await Promise.all([moduleForLoader(), modelBytes(descriptor.file)]);
    return (await new GLTFLoader().parseAsync(bytes, '')).scene;
  }

  function disposeScene(scene) {
    const geometries = new Set(), materials = new Set();
    scene.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) materials.add(material);
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
  }

  function drawInRect(ctx, image, rect, size, rotation = 0, drawPrint, printFile, projection) {
    const [atlasWidth, atlasHeight] = typeof size === 'number' ? [size, size] : [size.width, size.height];
    const [x, y, width, height] = [rect[0] * atlasWidth, rect[1] * atlasHeight, rect[2] * atlasWidth, rect[3] * atlasHeight];
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip();
    ctx.translate(x + width / 2, y + height / 2);
    ctx.rotate(rotation);
    const drawWidth = rotation ? height : width, drawHeight = rotation ? width : height;
    // A separately generated flat proof can reveal a small source-mesh crop
    // difference. Correct the preview projection inside its original atlas cell;
    // the full-resolution artwork, fulfillment file and adjacent cells stay put.
    if (projection) {
      ctx.translate(-drawWidth / 2, -drawHeight / 2);
      ctx.scale(drawWidth / printFile.width, drawHeight / printFile.height);
      ctx.scale(1 / (projection.scaleX || 1), 1 / (projection.scaleY || 1));
      ctx.translate(-(projection.offsetX || 0) * printFile.width, -(projection.offsetY || 0) * printFile.height);
      if (drawPrint) drawPrint(ctx);
      else ctx.drawImage(image, 0, 0, printFile.width, printFile.height);
      ctx.restore();
      return;
    }
    if (drawPrint) {
      ctx.scale(drawWidth / printFile.width, drawHeight / printFile.height);
      ctx.translate(-printFile.width / 2, -printFile.height / 2);
      drawPrint(ctx);
    } else ctx.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    ctx.restore();
  }

  function paintAtlas(ctx, size, descriptor, product, front, back, base, drawPrint, drawBackPrint) {
    const [width, height] = typeof size === 'number' ? [size, size] : [size.width, size.height];
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = product.previewModel?.color || '#ffffff';
    ctx.fillRect(0, 0, width, height);
    if (base) ctx.drawImage(base, 0, 0, width, height);
    const cell = (index, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(index % 2 * width / 2, Math.floor(index / 2) * height / 2, width / 2, height / 2);
    };
    if (descriptor.accentCell !== undefined) cell(descriptor.accentCell, product.previewModel?.accent || '#ffffff');
    for (const [index, color] of Object.entries(descriptor.staticCells || {})) cell(Number(index), color);
    if (descriptor.metallicCell !== undefined) {
      const index = descriptor.metallicCell, left = index % 2 * width / 2;
      const gradient = ctx.createLinearGradient(left, 0, left + width / 2, 0);
      for (const [offset, color] of [[0, '#a4a8ab'], [.2, '#eeeeee'], [.5, '#8f9498'], [.8, '#eeeeee'], [1, '#a4a8ab']]) gradient.addColorStop(offset, color);
      cell(index, gradient);
    }
    const rotation = descriptor.canvas && product.orientation === 'landscape' ? Math.PI / 2 : 0;
    drawInRect(ctx, front, descriptor.front, size, rotation, drawPrint, product.printFile, descriptor.frontProjection);
    if (descriptor.back && (back || drawBackPrint)) drawInRect(ctx, back, descriptor.back, size, 0, drawBackPrint, product.printFile);
  }

  function colorAccentIslands(THREE, mesh, specification, accent) {
    const geometry = mesh.geometry, positions = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
    const indices = geometry.getIndex();
    if (!indices || !uv || positions.count !== specification.vertexCount || geometry.getAttribute('color')) throw new Error('Unexpected accent mesh topology');
    // The pinned GLB has separate indexed islands for the inside/rim, inner
    // base and two handle halves. A constant color per island has no gradient
    // across a coating boundary and leaves all original geometry/UV buffers intact.
    const parents = Uint32Array.from({ length: positions.count }, (_, index) => index);
    const root = index => {
      while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; }
      return index;
    };
    for (let index = 0; index < indices.count; index += 3) {
      const a = root(indices.getX(index));
      parents[root(indices.getX(index + 1))] = a;
      parents[root(indices.getX(index + 2))] = a;
    }
    const counts = new Map();
    for (let index = 0; index < positions.count; index++) counts.set(root(index), (counts.get(root(index)) || 0) + 1);
    const selected = new Set();
    for (const part of specification.parts) {
      if (!Number.isInteger(part.seed) || part.seed < 0 || part.seed >= positions.count || counts.get(root(part.seed)) !== part.vertices) throw new Error('Accent island changed');
      selected.add(root(part.seed));
    }
    const color = new THREE.Color(accent), colors = new Float32Array(positions.count * 3).fill(1);
    for (let index = 0; index < positions.count; index++) if (selected.has(root(index))) {
      if (uv.getX(index) < .5) throw new Error('Accent island overlaps the print area');
      color.toArray(colors, index * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      material.vertexColors = true; material.needsUpdate = true;
    }
  }

  function prepareScene(THREE, scene, product, texture) {
    const descriptor = product.previewMesh;
    const model = new THREE.Group();
    model.add(scene);
    model.rotation.x = (descriptor.rotateX || 0) * Math.PI / 180;
    model.rotation.y = (descriptor.rotateY || 0) * Math.PI / 180;
    model.updateMatrixWorld(true);
    let bounds = new THREE.Box3().setFromObject(model);
    if (descriptor.heightMaterial) {
      const bodyBounds = new THREE.Box3();
      model.traverse(object => {
        if (object.isMesh && object.material.name === descriptor.heightMaterial) bodyBounds.expandByObject(object);
      });
      if (!bodyBounds.isEmpty()) bounds = bodyBounds;
    }
    const size = bounds.getSize(new THREE.Vector3());
    const desiredHeight = descriptor.height || (descriptor.canvas
      ? product.orientation === 'landscape' ? product.previewModel.width : product.previewModel.height
      : product.previewModel?.height);
    if (!(size.y > 0) || !(desiredHeight > 0)) throw new Error('Invalid model dimensions');
    model.scale.setScalar(desiredHeight / size.y);
    if (descriptor.canvas && product.orientation === 'landscape') model.rotation.z = Math.PI / 2;
    model.updateMatrixWorld(true);
    const center = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
    if (['mug-325', 'mug-444', 'mug-591', 'colored-mug-325'].includes(descriptor.id)) {
      // These assets combine the cup and handle in one mesh. Their complete
      // bounds put the pivot beside the cylinder. The circular top rim gives
      // its actual vertical axis without moving vertices or changing UVs.
      const preciseBounds = new THREE.Box3().setFromObject(model, true);
      const rimBounds = new THREE.Box3(), point = new THREE.Vector3();
      const rimBottom = preciseBounds.max.y - desiredHeight * .02;
      model.traverse(object => {
        const vertices = object.geometry?.getAttribute('position');
        for (let index = 0; index < (vertices?.count || 0); index++) {
          point.fromBufferAttribute(vertices, index).applyMatrix4(object.matrixWorld);
          if (point.y >= rimBottom) rimBounds.expandByPoint(point);
        }
      });
      if (!rimBounds.isEmpty()) {
        const axis = rimBounds.getCenter(new THREE.Vector3());
        center.x = axis.x; center.z = axis.z;
      }
    }
    model.position.sub(center);
    if (descriptor.diameter > 0) {
      // A cylindrical animation can reuse the catalog mesh at its established
      // surface radius while retaining the original geometry and height.
      model.updateMatrixWorld(true);
      const depth = new THREE.Box3().setFromObject(model, true).getSize(new THREE.Vector3()).z;
      const radialScale = descriptor.diameter / depth;
      model.scale.x *= radialScale; model.scale.z *= radialScale;
      model.position.x *= radialScale; model.position.z *= radialScale;
    }
    let printed = 0;
    model.traverse(object => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        const usesPrint = !descriptor.printMaterials || descriptor.printMaterials.includes(material.name);
        if (usesPrint) {
          material.map = texture;
          material.color.set('#ffffff');
          if (descriptor.textile || descriptor.canvas) material.roughness = .92;
          else if (!['coaster', 'notebook'].includes(descriptor.id)) material.roughness = .38;
          if (descriptor.canvas && material.name === 'metālam') { material.metalness = .75; material.roughness = .3; }
          printed++;
        } else if (/metal|inside/.test(material.name)) {
          material.color.set(material.name.includes('inside') ? '#899095' : '#b6bdc1');
          material.metalness = .8;
          material.roughness = .22;
        }
        material.envMapIntensity = material.metalness >= .5 ? .7 : .05;
        material.needsUpdate = true;
      }
      if (descriptor.accentIslands) colorAccentIslands(THREE, object, descriptor.accentIslands, product.previewModel.accent);
    });
    if (!printed) throw new Error('Expected print material is missing');
    model.userData.printfulModel = descriptor.id;
    return model;
  }

  async function load(THREE, product, front, back, options = {}) {
    const descriptor = product.previewMesh;
    const scene = await (options.loadScene || loadScene)(descriptor);
    let texture;
    try {
      let base = null;
      if (descriptor.baseAtlas) {
        base = options.loadImage ? await options.loadImage(descriptor.baseAtlas) : await new Promise((resolve, reject) => {
          const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = descriptor.baseAtlas;
        });
      }
      const canvas = options.createCanvas ? options.createCanvas() : document.createElement('canvas');
      const dimensions = atlasSizeFor(product, options.maxTextureSize || 4096);
      canvas.width = dimensions.width; canvas.height = dimensions.height;
      const context = canvas.getContext('2d');
      texture = new THREE.CanvasTexture(canvas);
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = options.anisotropy || 1;
      const model = prepareScene(THREE, scene, product, texture);
      const update = () => {
        paintAtlas(context, dimensions, descriptor, product, front, back, base, options.drawPrint, options.drawBackPrint);
        texture.needsUpdate = true;
      };
      update();
      let disposed = false;
      return { model, texture, canvas, update, dispose() {
        if (disposed) return;
        disposed = true;
        disposeScene(model); texture.dispose(); model.removeFromParent();
      } };
    } catch (error) { disposeScene(scene); texture?.dispose(); throw error; }
  }

  return Object.freeze({ load, prepareScene, paintAtlas, disposeScene, atlasSizeFor });
});
