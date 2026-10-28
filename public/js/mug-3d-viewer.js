(function (root) {
  'use strict';

  const DEFAULT_PRODUCT = Object.freeze({
    size: Object.freeze({ heightCm: 9.6, diameterCm: 8.2 }),
    printFile: Object.freeze({ width: 2700, height: 1050, dpi: 300 }),
  });

  // Only the outer profile can determine the framing of a full horizontal
  // turn. Its convex hull keeps the exact outer shape without scanning every
  // mesh vertex again on each viewport resize.
  function turnProfile(points) {
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const half = values => {
      const result = [];
      for (const point of values) {
        while (result.length > 1 && cross(result.at(-2), result.at(-1), point) <= 0) result.pop();
        result.push(point);
      }
      result.pop(); return result;
    };
    return [...half(points), ...half([...points].reverse())];
  }

  function textureSizeFor(product) {
    if (product.previewMesh) return { width: product.printFile.width, height: product.printFile.height };
    if (product.previewModel && ['case', 'canvas', 'panel', 'mousepad', 'sleeve', 'tote', 'pillow', 'blanket', 'garment'].includes(product.previewModel.kind)) {
      return { width: product.printFile.width, height: product.printFile.height };
    }
    const printWidthCm = (product.printFile.width / product.printFile.dpi) * 2.54;
    const printHeightCm = (product.printFile.height / product.printFile.dpi) * 2.54;
    return {
      width: Math.round(
        product.printFile.width * (Math.PI * product.size.diameterCm) / printWidthCm
      ),
      height: Math.round(
        product.printFile.height * product.size.heightCm / printHeightCm
      ),
    };
  }

  function create(options) {
    const THREE = options.THREE || root.THREE;
    const host = options.host;
    const product = options.product || DEFAULT_PRODUCT;
    const providerModel = product.previewMesh || null;
    const bagPreview = product.previewModel?.kind === 'tote';
    const garmentPreview = product.previewModel?.kind === 'garment';
    const studioPreview = Boolean(providerModel || product.previewModel);
    let modelView = null;
    let clothView = null;
    let modelPending = Boolean(providerModel);
    let modelFailed = false;
    if (!THREE) throw new Error('Three.js failed to load');
    if (!host) throw new Error('A mug viewer host is required');

    const ownsCanvas = !options.canvas;
    const canvas = options.canvas || document.createElement('canvas');
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    if (studioPreview) { renderer.toneMapping = garmentPreview ? THREE.ACESFilmicToneMapping : THREE.LinearToneMapping; renderer.toneMappingExposure = garmentPreview ? 1.12 : 1; }
    if (!options.canvas) host.prepend(canvas);

    const ownsInteractionRegion = !options.interactionRegion;
    const interactionRegion = options.interactionRegion || document.createElement('span');
    interactionRegion.classList.add('mug-interaction-region');
    interactionRegion.setAttribute('aria-hidden', 'true');
    if (ownsInteractionRegion) host.append(interactionRegion);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(31, 1, .1, 100);
    camera.position.set(0, 2.35, 27);
    camera.lookAt(0, 0, 0);

    const group = new THREE.Group();
    group.position.y = options.positionY == null ? .5 : options.positionY;
    group.rotation.y = options.initialRotationY == null ? (bagPreview ? .38 : .14) : options.initialRotationY;
    if (bagPreview) group.rotation.x = .08;
    scene.add(group);

    const dimensions = textureSizeFor(product);
    const textureLimit = options.maxTextureSize || (product.previewModel || providerModel ? 2048 : Infinity);
    const textureScale = Math.min(1, textureLimit / Math.max(dimensions.width, dimensions.height));
    const textureCanvas = document.createElement('canvas');
    textureCanvas.width = Math.ceil(dimensions.width * textureScale);
    textureCanvas.height = Math.ceil(dimensions.height * textureScale);
    const textureContext = textureCanvas.getContext('2d');
    textureContext.fillStyle = product.previewModel?.color || '#ffffff';
    textureContext.fillRect(0, 0, textureCanvas.width, textureCanvas.height);
    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

    const backCanvas = product.previewModel?.kind === 'pillow' || providerModel?.back ? document.createElement('canvas') : null;
    let backTexture = null;
    if (backCanvas) {
      backCanvas.width = textureCanvas.width; backCanvas.height = textureCanvas.height;
      backTexture = new THREE.CanvasTexture(backCanvas); backTexture.colorSpace = THREE.SRGBColorSpace;
    }
    if (providerModel) {
      // Original meshes attach only after their local GLB and print atlas are
      // ready. Loading failures keep the existing explicit retry state.
    } else if (product.previewModel) {
      const proceduralView = root.Product3DGeometry.build(THREE, group, texture, product, backTexture);
      if (['blanket', 'garment'].includes(product.previewModel.kind)) clothView = proceduralView;
    } else {
    const height = product.size.heightCm;
    const radius = product.size.diameterCm / 2;
    const bottomRadius = radius * .985;
    const edgeRadius = .09;
    const shellHeight = height - edgeRadius * 2;
    // Printful file 43 ends beside the handle, so its UV seam belongs on
    // the handle axis rather than on the visible front of the mug.
    const handleSeamAngle = -Math.PI / 2;
    const ceramic = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: texture,
      roughness: .38,
      metalness: .04,
    });
    const plainCeramic = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: .38,
      metalness: .04,
    });
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(
        radius,
        bottomRadius,
        shellHeight,
        160,
        1,
        true,
        handleSeamAngle,
        Math.PI * 2
      ),
      ceramic
    );
    group.add(body);

    const innerRadius = radius - edgeRadius * 2;
    const interiorBottomRadius = bottomRadius - .42;
    const interiorTopY = shellHeight / 2;
    const interiorBottomY = -height / 2 + .52;
    const interiorHeight = interiorTopY - interiorBottomY;
    const inside = new THREE.Mesh(
      new THREE.CylinderGeometry(
        innerRadius,
        interiorBottomRadius,
        interiorHeight,
        160,
        1,
        true,
        -Math.PI,
        Math.PI * 2
      ),
      new THREE.MeshStandardMaterial({
        color: 0xf3f3f3,
        roughness: .52,
        metalness: .01,
        side: THREE.BackSide,
      })
    );
    inside.position.y = (interiorTopY + interiorBottomY) / 2;
    group.add(inside);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry((radius + innerRadius) / 2, (radius - innerRadius) / 2, 24, 160),
      plainCeramic
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = interiorTopY;
    group.add(rim);

    const interiorBottom = new THREE.Mesh(
      new THREE.CircleGeometry(interiorBottomRadius, 160),
      new THREE.MeshStandardMaterial({
        color: 0xe6e7e8,
        roughness: .68,
        metalness: 0,
        side: THREE.DoubleSide,
      })
    );
    interiorBottom.rotation.x = -Math.PI / 2;
    interiorBottom.position.y = interiorBottomY + .015;
    group.add(interiorBottom);

    const bottom = new THREE.Mesh(
      new THREE.CircleGeometry(bottomRadius - .03, 160),
      plainCeramic
    );
    bottom.rotation.x = Math.PI / 2;
    bottom.position.y = -height / 2 + .01;
    bottom.receiveShadow = true;
    group.add(bottom);

    const handlePath = new THREE.CatmullRomCurve3(
      [
        new THREE.Vector3(-radius + .24, 3.62, 0),
        new THREE.Vector3(-radius - .95, 3.68, 0),
        new THREE.Vector3(-radius - 2.34, 3.02, 0),
        new THREE.Vector3(-radius - 3.02, 1.42, 0),
        new THREE.Vector3(-radius - 3.12, 0, 0),
        new THREE.Vector3(-radius - 3.02, -1.42, 0),
        new THREE.Vector3(-radius - 2.34, -2.9, 0),
        new THREE.Vector3(-radius - .95, -3.54, 0),
        new THREE.Vector3(-radius + .24, -3.48, 0),
      ],
      false,
      'centripetal',
      .5
    );
    const handleGeometry = new THREE.TubeGeometry(handlePath, 160, .4, 28, false);
    const handlePositions = handleGeometry.getAttribute('position');
    const cavityBoundary = innerRadius + .015;
    for (let vertexIndex = 0; vertexIndex < handlePositions.count; vertexIndex++) {
      const x = handlePositions.getX(vertexIndex);
      const z = handlePositions.getZ(vertexIndex);
      const radialDistance = Math.hypot(x, z);
      if (radialDistance >= cavityBoundary) continue;
      const radialScale = cavityBoundary / radialDistance;
      handlePositions.setXYZ(
        vertexIndex,
        x * radialScale,
        handlePositions.getY(vertexIndex),
        z * radialScale
      );
    }
    handlePositions.needsUpdate = true;
    handleGeometry.computeVertexNormals();
    group.add(new THREE.Mesh(handleGeometry, plainCeramic));

    const baseRim = new THREE.Mesh(
      new THREE.TorusGeometry(bottomRadius - edgeRadius, edgeRadius, 24, 160),
      plainCeramic
    );
    baseRim.rotation.x = Math.PI / 2;
    baseRim.position.y = -shellHeight / 2;
    group.add(baseRim);

    }

    // Measure around the product's rotation origin without changing its mesh.
    // Fit-to-view previews reserve a complete turn and tilt; other hosts use a sphere.
    const framingPoint = new THREE.Vector3();
    const rotationEnvelope = { profile: [], distance: null };
    let framingRadius = 1;
    function measureModel() {
      group.updateMatrixWorld(true);
      const inverseGroup = group.matrixWorld.clone().invert();
      let rotationRadius = 0;
      const profile = [];
      rotationEnvelope.distance = null;
      group.traverse(mesh => {
        const vertices = mesh.geometry?.getAttribute('position');
        if (!vertices) return;
        for (let index = 0; index < vertices.count; index++) {
          framingPoint.fromBufferAttribute(vertices, index).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverseGroup);
          rotationRadius = Math.max(rotationRadius, framingPoint.length());
          if (options.fitToView) {
            profile.push([Math.hypot(framingPoint.x, framingPoint.z), framingPoint.y]);
          }
        }
      });
      rotationEnvelope.profile = turnProfile(profile);
      framingRadius = rotationRadius + group.position.length();
    }
    if (!modelPending) measureModel();
    const cameraDirection = camera.position.clone().normalize();
    const defaultCameraDistance = camera.position.length();

    let studioTexture = null;
    if (product.previewModel || providerModel) {
      const studioCanvas = document.createElement('canvas'); studioCanvas.width = 512; studioCanvas.height = 256;
      const studio = studioCanvas.getContext('2d');
      if (studio.createLinearGradient) {
        const gradient = studio.createLinearGradient(0, 0, 512, 0);
        const reflections = [[0, '#aaaaaa'], [.12, '#eeeeee'], [.22, '#ffffff'], [.28, '#aaaaaa'], [.48, '#dddddd'], [.58, '#ffffff'], [.67, '#ffffff'], [.76, '#999999'], [1, '#aaaaaa']];
        for (const [position, color] of reflections) gradient.addColorStop(position, color);
        studio.fillStyle = gradient; studio.fillRect(0, 0, 512, 256);
        studioTexture = new THREE.CanvasTexture(studioCanvas); studioTexture.mapping = THREE.EquirectangularReflectionMapping;
        studioTexture.colorSpace = THREE.SRGBColorSpace; scene.environment = studioTexture;
      }
    }
    const lightScale = garmentPreview ? 1 : bagPreview ? 1.05 : clothView ? 1 : studioPreview ? .9 : 1;
    const lightColor = studioPreview ? 0xffffff : 0xfffaf5;
    if (product.previewModel) group.traverse(mesh => {
      for (const surface of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) surface.envMapIntensity = surface.metalness >= .5 ? .7 : garmentPreview ? (product.previewModel.color === '#0b0b0b' ? .35 : .08) : .05;
    });
    scene.add(new THREE.AmbientLight(0xffffff, (garmentPreview ? 1.9 : bagPreview ? 1.35 : 1.9) * lightScale));
    const keyLight = new THREE.DirectionalLight(lightColor, (garmentPreview ? 3.0 : bagPreview ? 1.6 : 1.15) * lightScale);
    keyLight.position.set(garmentPreview ? -3 : 2.2, garmentPreview ? 4 : 1.8, 2.5);
    if (garmentPreview && renderer.shadowMap) {
      // A single bounded soft shadow pass adds contact beneath the hood,
      // pocket and sleeve folds. Other products keep their existing lighting.
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      keyLight.position.set(-90, 120, 110); keyLight.castShadow = true;
      const reach = Math.max(product.previewModel.height, product.previewModel.width) * .8;
      Object.assign(keyLight.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: 350 });
      keyLight.shadow.mapSize.set(1024, 1024); keyLight.shadow.normalBias = .14; keyLight.shadow.bias = -.0003;
    }
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(lightColor, (garmentPreview ? .65 : bagPreview ? .7 : .85) * lightScale);
    fillLight.position.set(garmentPreview ? 3 : -2.4, 1, garmentPreview ? 2 : -2.2);
    scene.add(fillLight);
    const rimLight = new THREE.DirectionalLight(0xffffff, .45 * lightScale);
    rimLight.position.set(0, 2.2, -3);
    scene.add(rimLight);
    const underLight = new THREE.DirectionalLight(lightColor, (garmentPreview ? .18 : bagPreview ? .3 : .55) * lightScale);
    underLight.position.set(.5, -2.2, 1.8);
    scene.add(underLight);

    let textureDrawer = options.drawTexture || null;
    let activePointer = null;
    let lastX = 0;
    let lastY = 0;
    let autoFrame = null;
    let autoStart = null;
    let clothFrame = null, clothLast = null, clothVisible = true, clothGrabbed = false;
    const clothDragPlane = new THREE.Plane(), clothDragPoint = new THREE.Vector3();
    const autoStartRotation = group.rotation.y;
    const interactionElement = options.interactionElement || host;
    const raycaster = new THREE.Raycaster();
    const rayPointer = new THREE.Vector2();
    const worldBounds = new THREE.Box3();
    const projectedCorner = new THREE.Vector3();
    const maxVerticalRotation = Math.PI / 6;
    let destroyed = false;
    const reportStatus = (status) => options.onStatus?.(status);

    function stopClothMotion() {
      if (clothFrame !== null) root.cancelAnimationFrame(clothFrame);
      clothFrame = null; clothLast = null;
    }
    function animateCloth(now) {
      if (clothFrame === null) return;
      clothFrame = null;
      if (destroyed || !clothVisible || document.hidden || renderer.getContext().isContextLost()) return;
      const elapsed = clothLast === null ? 1 / 90 : Math.max(0, (now - clothLast) / 1000);
      clothLast = now;
      clothView.advance(elapsed);
      render({ updateInteractionRegion: !clothView.active });
      startClothMotion();
    }
    function startClothMotion() {
      if (!clothView?.active || destroyed || !clothVisible || document.hidden || renderer.getContext().isContextLost() || clothFrame !== null) return;
      clothFrame = root.requestAnimationFrame(animateCloth);
    }
    function releaseCloth() {
      if (!clothView) return;
      clothGrabbed = false; clothView.release(); startClothMotion();
    }
    function visibilityChanged() {
      if (destroyed) return;
      if (!clothVisible || document.hidden) {
        if (activePointer !== null) resetPointer({ pointerId: activePointer });
        releaseCloth(); stopClothMotion();
      } else { clothLast = null; startClothMotion(); }
    }
    const clothObserver = clothView && root.IntersectionObserver ? new root.IntersectionObserver(entries => {
      clothVisible = entries.some(entry => entry.isIntersecting); visibilityChanged();
    }) : null;
    if (clothView) { document.addEventListener?.('visibilitychange', visibilityChanged); clothObserver?.observe(host); }

    function updateInteractionRegion() {
      const canvasRect = canvas.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      if (!canvasRect.width || !canvasRect.height || !hostRect.width || !hostRect.height) return;

      camera.updateMatrixWorld();
      scene.updateMatrixWorld(true);
      worldBounds.setFromObject(group);
      let minX = 1;
      let maxX = -1;
      let minY = 1;
      let maxY = -1;
      for (const x of [worldBounds.min.x, worldBounds.max.x]) {
        for (const y of [worldBounds.min.y, worldBounds.max.y]) {
          for (const z of [worldBounds.min.z, worldBounds.max.z]) {
            projectedCorner.set(x, y, z).project(camera);
            minX = Math.min(minX, projectedCorner.x);
            maxX = Math.max(maxX, projectedCorner.x);
            minY = Math.min(minY, projectedCorner.y);
            maxY = Math.max(maxY, projectedCorner.y);
          }
        }
      }

      const padding = Math.min(12, canvasRect.width * .025);
      const canvasOffsetX = canvasRect.left - hostRect.left;
      const canvasOffsetY = canvasRect.top - hostRect.top;
      const left = canvasOffsetX + ((minX + 1) / 2) * canvasRect.width - padding;
      const right = canvasOffsetX + ((maxX + 1) / 2) * canvasRect.width + padding;
      const top = canvasOffsetY + ((1 - maxY) / 2) * canvasRect.height - padding;
      const bottom = canvasOffsetY + ((1 - minY) / 2) * canvasRect.height + padding;
      const boundedLeft = Math.max(0, left);
      const boundedTop = Math.max(0, top);
      interactionRegion.style.left = `${boundedLeft}px`;
      interactionRegion.style.top = `${boundedTop}px`;
      interactionRegion.style.width = `${Math.max(0, Math.min(hostRect.width, right) - boundedLeft)}px`;
      interactionRegion.style.height = `${Math.max(0, Math.min(hostRect.height, bottom) - boundedTop)}px`;
    }

    function render(renderOptions) {
      if (destroyed || modelPending || modelFailed || renderer.getContext().isContextLost()) return;
      if (options.fitToView) fitCameraToView();
      if (renderOptions?.updateInteractionRegion !== false) updateInteractionRegion();
      renderer.render(scene, camera);
    }

    // Fit the complete rotation once per viewport/fill, rather than following
    // the changing outline during a drag. Flat products otherwise zoom as they
    // turn edge-on. The cached distance also keeps the framing center fixed.
    const cameraRight = new THREE.Vector3(), cameraUp = new THREE.Vector3();
    function rotationCameraDistance(horizontal, vertical, fill) {
      if (rotationEnvelope.distance !== null && rotationEnvelope.aspect === camera.aspect && rotationEnvelope.fill === fill) return rotationEnvelope.distance;
      let distance = 1;
      for (const [axis, slope] of [[cameraRight, horizontal], [cameraUp, vertical]]) for (const sign of [-1, 1]) {
        const plane = cameraDirection.clone().addScaledVector(axis, sign / slope);
        // Bound a full yaw turn at every supported pitch. A 0.5% allowance
        // covers extrema between the one-degree samples and floating point.
        for (let step = 0; step <= 60; step++) {
          const pitch = maxVerticalRotation * (step / 30 - 1), sin = Math.sin(pitch), cos = Math.cos(pitch);
          const yCoefficient = plane.y * cos + plane.z * sin;
          const radial = Math.hypot(plane.x, -plane.y * sin + plane.z * cos);
          for (const [radius, y] of rotationEnvelope.profile) distance = Math.max(distance, y * yCoefficient + radius * radial);
        }
      }
      rotationEnvelope.aspect = camera.aspect; rotationEnvelope.fill = fill;
      return (rotationEnvelope.distance = distance * 1.005);
    }
    function fitCameraToView() {
      group.updateMatrixWorld(true);
      camera.updateMatrixWorld();
      cameraRight.setFromMatrixColumn(camera.matrixWorld, 0);
      cameraUp.setFromMatrixColumn(camera.matrixWorld, 1);
      const fill = Math.min(.96, Math.max(.5, options.framingFill?.() ?? .92));
      const vertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * fill;
      const horizontal = vertical * camera.aspect;
      const distance = rotationCameraDistance(horizontal, vertical, fill);
      camera.position.copy(cameraDirection).multiplyScalar(distance).add(group.position);
      camera.lookAt(group.position);
      camera.far = Math.max(100, distance + framingRadius * 2);
      camera.near = Math.max(.1, (distance - framingRadius) * .5);
      camera.updateProjectionMatrix();
    }

    function resize(paint = true) {
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const densityLimit = options.maxPixelRatio || 2;
      const areaLimit = options.maxRenderPixels > 0
        ? Math.sqrt(options.maxRenderPixels / (rect.width * rect.height)) : Infinity;
      renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, densityLimit, areaLimit));
      renderer.setSize(rect.width, rect.height, false);
      camera.aspect = rect.width / rect.height;
      const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2);
      const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
      const fill = options.framingFill?.() ?? .88;
      const distance = framingRadius / (Math.sin(Math.min(verticalHalfFov, horizontalHalfFov)) * fill);
      camera.position.copy(cameraDirection).multiplyScalar(Math.max(defaultCameraDistance, distance));
      camera.far = Math.max(100, distance + framingRadius * 2);
      camera.near = Math.max(.1, (Math.max(defaultCameraDistance, distance) - framingRadius) * .5);
      camera.updateProjectionMatrix();
      if (paint) render();
    }

    function printDrawingOptions() {
      // A provider mesh already locates the complete file in its UV atlas.
      // Physical offsets belong only to the full-body procedural textures.
      return {
        offsetX: providerModel ? 0 : (dimensions.width - product.printFile.width) / 2,
        offsetY: providerModel ? 0 : (dimensions.height - product.printFile.height) / 2 -
          (product.previewModel?.printCenterY || 0) * product.printFile.dpi / 2.54,
        printWidth: product.printFile.width, printHeight: product.printFile.height,
        textureWidth: dimensions.width, textureHeight: dimensions.height,
      };
    }

    function drawPrint(ctx) {
      textureDrawer?.(ctx, printDrawingOptions());
    }

    function drawBackPrint(ctx) {
      options.drawBackTexture?.(ctx, printDrawingOptions());
    }

    function updateTexture(nextDrawer) {
      if (destroyed) return;
      if (nextDrawer) textureDrawer = nextDrawer;
      const ctx = textureCanvas.getContext('2d');
      ctx.clearRect(0, 0, textureCanvas.width, textureCanvas.height);
      ctx.fillStyle = product.previewModel?.color || '#ffffff';
      ctx.fillRect(0, 0, textureCanvas.width, textureCanvas.height);
      if (textureDrawer) {
        ctx.save?.(); ctx.scale?.(textureScale, textureScale);
        drawPrint(ctx);
        ctx.restore?.();
      }
      texture.needsUpdate = true;
      if (backCanvas) {
        const backContext = backCanvas.getContext('2d');
        backContext.clearRect(0, 0, backCanvas.width, backCanvas.height);
        backContext.fillStyle = '#ffffff'; backContext.fillRect(0, 0, backCanvas.width, backCanvas.height);
        backContext.save?.(); backContext.scale?.(textureScale, textureScale);
        drawBackPrint(backContext);
        backContext.restore?.();
        backTexture.needsUpdate = true;
      }
      modelView?.update();
      render();
    }

    function stopAutoRotate() {
      if (autoFrame !== null) root.cancelAnimationFrame(autoFrame);
      autoFrame = null;
    }

    function animateAutoRotate(now) {
      if (autoFrame === null) return;
      if (autoStart === null) autoStart = now;
      const duration = options.autoRotateDurationMs || 9000;
      const progress = Math.min(1, (now - autoStart) / duration);
      const eased = progress < .5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;
      group.rotation.y = autoStartRotation + eased * Math.PI * 2;
      render();
      if (progress >= 1) {
        autoFrame = null;
        return;
      }
      autoFrame = root.requestAnimationFrame(animateAutoRotate);
    }

    function startAutoRotate() {
      stopAutoRotate();
      autoStart = null;
      autoFrame = root.requestAnimationFrame(animateAutoRotate);
    }

    function updatePointerRay(event) {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      rayPointer.set(
        ((event.clientX - (rect.left || 0)) / rect.width) * 2 - 1,
        -((event.clientY - (rect.top || 0)) / rect.height) * 2 + 1
      );
      camera.updateMatrixWorld();
      scene.updateMatrixWorld(true);
      raycaster.setFromCamera(rayPointer, camera);
      return true;
    }
    function pointerHit(event) {
      if (!updatePointerRay(event)) return null;
      return raycaster.intersectObject(group, true)[0] || null;
    }

    function capturePointer(event) {
      if (!interactionElement.setPointerCapture) return;
      try { interactionElement.setPointerCapture(event.pointerId); }
      catch { /* A cancelled or synthetic contact may already have ended. */ }
    }

    function resetPointer(event) {
      activePointer = null;
      interactionElement.classList.remove('dragging');
      if (interactionElement.hasPointerCapture?.(event.pointerId)) {
        interactionElement.releasePointerCapture(event.pointerId);
      }
    }

    const handlePointerDown = (event) => {
      if (activePointer !== null || event.isPrimary === false) return;
      const isTouch = event.pointerType === 'touch';
      const hit = clothView || isTouch ? pointerHit(event) : null;
      if (isTouch && !options.rotateAnywhere?.() && !hit) return;
      if (!isTouch && event.button != null && event.button !== 0) return;
      activePointer = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      stopAutoRotate();
      if (clothView && hit) {
        clothGrabbed = clothView.beginGrab(hit);
        if (clothGrabbed) {
          clothDragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), hit.point);
          startClothMotion();
        }
      }
      capturePointer(event);
      interactionElement.classList.add('dragging');
      event.preventDefault();
    };
    const handlePointerMove = (event) => {
      if (event.pointerId !== activePointer) return;
      const deltaX = event.clientX - lastX;
      const deltaY = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      if (clothGrabbed) {
        if (updatePointerRay(event) && raycaster.ray.intersectPlane(clothDragPlane, clothDragPoint)) clothView.moveGrab(clothDragPoint);
        startClothMotion(); event.preventDefault(); return;
      }
      group.rotation.y += deltaX * .012;
      group.rotation.x = Math.max(
        -maxVerticalRotation,
        Math.min(maxVerticalRotation, group.rotation.x + deltaY * .0065)
      );
      render();
      event.preventDefault();
    };
    const finishPointer = (event) => {
      if (event.pointerId !== activePointer) return;
      resetPointer(event);
      releaseCloth();
    };
    // Gallery touch-action permits scrolling through the model's transparent
    // rectangular bounds. Cancel the native gesture only when it starts on
    // actual geometry; cancelling pointerdown alone cannot reserve touch pans.
    // Keep this local to the viewer and out of the continuous move path.
    const handleTouchStart = (event) => {
      if (event.touches.length !== 1) return;
      if (options.rotateAnywhere?.() || pointerHit(event.touches[0])) event.preventDefault();
    };
    const handleKeydown = (event) => {
      if (clothView && (event.key === ' ' || event.code === 'Space')) {
        if (event.repeat || activePointer !== null) { event.preventDefault(); return; }
        stopAutoRotate(); clothView.demonstrate(); startClothMotion(); event.preventDefault(); return;
      }
      if (clothView && event.key === 'Escape') {
        if (activePointer !== null) resetPointer({ pointerId: activePointer });
        releaseCloth(); event.preventDefault(); return;
      }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      stopAutoRotate();
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        group.rotation.y += event.key === 'ArrowLeft' ? -.18 : .18;
      } else {
        const nextRotation = group.rotation.x + (event.key === 'ArrowUp' ? -.09 : .09);
        group.rotation.x = Math.max(-maxVerticalRotation, Math.min(maxVerticalRotation, nextRotation));
      }
      render();
      event.preventDefault();
    };
    interactionElement.addEventListener('pointerdown', handlePointerDown);
    interactionElement.addEventListener('pointermove', handlePointerMove);
    interactionElement.addEventListener('pointerup', finishPointer);
    interactionElement.addEventListener('pointercancel', finishPointer);
    interactionElement.addEventListener('lostpointercapture', finishPointer);
    interactionElement.addEventListener('keydown', handleKeydown);
    interactionElement.addEventListener('touchstart', handleTouchStart, { passive: false });
    const preventNativeInteraction = (event) => event.preventDefault();
    interactionRegion.addEventListener('contextmenu', preventNativeInteraction);
    interactionRegion.addEventListener('dragstart', preventNativeInteraction);
    interactionRegion.addEventListener('selectstart', preventNativeInteraction);

    const onContextLost = (event) => {
      event.preventDefault();
      stopAutoRotate();
      if (clothView && activePointer !== null) resetPointer({ pointerId: activePointer });
      releaseCloth(); stopClothMotion();
      reportStatus('error');
    };
    const onContextRestored = () => {
      if (destroyed) return;
      try { resize(); updateTexture(); startClothMotion(); reportStatus(modelFailed ? 'error' : modelPending ? 'loading' : 'ready'); }
      catch { reportStatus('error'); }
    };
    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (activePointer !== null) resetPointer({ pointerId: activePointer });
      stopAutoRotate();
      stopClothMotion(); clothObserver?.disconnect();
      if (clothView) document.removeEventListener?.('visibilitychange', visibilityChanged);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      interactionElement.removeEventListener('pointerdown', handlePointerDown);
      interactionElement.removeEventListener('pointermove', handlePointerMove);
      interactionElement.removeEventListener('pointerup', finishPointer);
      interactionElement.removeEventListener('pointercancel', finishPointer);
      interactionElement.removeEventListener('lostpointercapture', finishPointer);
      interactionElement.removeEventListener('keydown', handleKeydown);
      interactionElement.removeEventListener('touchstart', handleTouchStart);
      interactionRegion.removeEventListener('contextmenu', preventNativeInteraction);
      interactionRegion.removeEventListener('dragstart', preventNativeInteraction);
      interactionRegion.removeEventListener('selectstart', preventNativeInteraction);
      interactionElement.classList.remove('dragging');
      modelView?.dispose();
      modelView = null;
      clothView?.dispose();
      group.traverse((object) => {
        object.geometry?.dispose?.();
        if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose?.());
        else object.material?.dispose?.();
      });
      texture.dispose();
      backTexture?.dispose();
      studioTexture?.dispose();
      if (garmentPreview) keyLight.shadow.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (ownsInteractionRegion) interactionRegion.remove();
      if (ownsCanvas) canvas.remove();
    }

    try {
      resize(false);
      updateTexture();
      if (renderer.getContext().isContextLost()) throw new Error('webgl_context_lost');
      if (options.autoRotate && !modelPending) startAutoRotate();
    } catch (error) { destroy(); throw error; }

    const ready = providerModel ? Promise.resolve().then(() => {
      if (destroyed) return null;
      reportStatus('loading');
      return root.PrintfulProductModel.load(THREE, product, textureCanvas, backCanvas, {
        anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
        maxTextureSize: renderer.capabilities.maxTextureSize,
        drawPrint,
        drawBackPrint,
        ...(options.modelOptions || {}),
      });
    }).then(loaded => {
      if (!loaded) return false;
      if (destroyed) { loaded.dispose(); return false; }
      modelView = loaded;
      group.add(loaded.model);
      modelPending = false;
      measureModel();
      canvas.setAttribute('data-product-mesh', providerModel.id);
      // load() has already painted the current artwork into the provider atlas.
      // One render also makes that exact frame available to gallery thumbnails.
      resize();
      if (renderer.getContext().isContextLost()) reportStatus('error');
      else { reportStatus('ready'); if (options.autoRotate) startAutoRotate(); }
      return true;
    }).catch(() => {
      if (!destroyed) {
        modelPending = false;
        modelFailed = true;
        modelView?.dispose(); modelView = null;
        reportStatus('error');
      }
      return false;
    }) : Promise.resolve(true);

    return {
      THREE,
      renderer,
      scene,
      camera,
      group,
      canvas,
      interactionRegion,
      textureCanvas,
      texture,
      cloth: clothView,
      ready,
      get loading() { return modelPending; },
      render,
      resize,
      updateTexture,
      startAutoRotate,
      stopAutoRotate,
      destroy,
    };
  }

  root.Mug3DViewer = Object.freeze({ DEFAULT_PRODUCT, create, textureSizeFor });
})(typeof window !== 'undefined' ? window : globalThis);
