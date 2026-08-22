(function (root) {
  'use strict';

  const DEFAULT_PRODUCT = Object.freeze({
    size: Object.freeze({ heightCm: 9.6, diameterCm: 8.2 }),
    printFile: Object.freeze({ width: 2700, height: 1050, dpi: 300 }),
  });

  function textureSizeFor(product) {
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
    if (!options.canvas) host.prepend(canvas);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(31, 1, .1, 100);
    camera.position.set(0, 2.35, 27);
    camera.lookAt(0, 0, 0);

    const group = new THREE.Group();
    group.position.y = options.positionY == null ? .5 : options.positionY;
    group.rotation.y = options.initialRotationY == null ? .14 : options.initialRotationY;
    scene.add(group);

    const dimensions = textureSizeFor(product);
    const textureCanvas = document.createElement('canvas');
    textureCanvas.width = dimensions.width;
    textureCanvas.height = dimensions.height;
    const textureContext = textureCanvas.getContext('2d');
    textureContext.fillStyle = '#ffffff';
    textureContext.fillRect(0, 0, textureCanvas.width, textureCanvas.height);
    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

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

    scene.add(new THREE.AmbientLight(0xffffff, 1.9));
    const keyLight = new THREE.DirectionalLight(0xfffaf5, 1.15);
    keyLight.position.set(2.2, 1.8, 2.5);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xfffaf5, .85);
    fillLight.position.set(-2.4, 1, -2.2);
    scene.add(fillLight);
    const rimLight = new THREE.DirectionalLight(0xffffff, .45);
    rimLight.position.set(0, 2.2, -3);
    scene.add(rimLight);
    const underLight = new THREE.DirectionalLight(0xfffaf5, .55);
    underLight.position.set(.5, -2.2, 1.8);
    scene.add(underLight);

    let textureDrawer = options.drawTexture || null;
    let activePointer = null;
    let lastX = 0;
    let lastY = 0;
    let autoFrame = null;
    let autoStart = null;
    const autoStartRotation = group.rotation.y;
    const interactionElement = options.interactionElement || host;
    const maxVerticalRotation = Math.PI / 6;

    function render() {
      renderer.render(scene, camera);
    }

    function resize() {
      const rect = host.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2));
      renderer.setSize(rect.width, rect.height, false);
      camera.aspect = rect.width / rect.height;
      camera.updateProjectionMatrix();
      render();
    }

    function updateTexture(nextDrawer) {
      if (nextDrawer) textureDrawer = nextDrawer;
      const ctx = textureCanvas.getContext('2d');
      ctx.clearRect(0, 0, textureCanvas.width, textureCanvas.height);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, textureCanvas.width, textureCanvas.height);
      const offsetX = (textureCanvas.width - product.printFile.width) / 2;
      const offsetY = (textureCanvas.height - product.printFile.height) / 2;
      if (textureDrawer) {
        textureDrawer(ctx, {
          offsetX,
          offsetY,
          printWidth: product.printFile.width,
          printHeight: product.printFile.height,
          textureWidth: textureCanvas.width,
          textureHeight: textureCanvas.height,
        });
      }
      texture.needsUpdate = true;
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

    const handlePointerDown = (event) => {
      stopAutoRotate();
      activePointer = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      interactionElement.setPointerCapture(event.pointerId);
      interactionElement.classList.add('dragging');
      event.preventDefault();
    };
    const handlePointerMove = (event) => {
      if (event.pointerId !== activePointer) return;
      const deltaX = event.clientX - lastX;
      const deltaY = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      group.rotation.y += deltaX * .012;
      group.rotation.x = Math.max(
        -maxVerticalRotation,
        Math.min(maxVerticalRotation, group.rotation.x + deltaY * .0065)
      );
      render();
    };
    const finishPointer = (event) => {
      if (event.pointerId !== activePointer) return;
      activePointer = null;
      interactionElement.classList.remove('dragging');
      if (interactionElement.hasPointerCapture(event.pointerId)) {
        interactionElement.releasePointerCapture(event.pointerId);
      }
    };
    const handleKeydown = (event) => {
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
    interactionElement.addEventListener('keydown', handleKeydown);

    function destroy() {
      stopAutoRotate();
      interactionElement.removeEventListener('pointerdown', handlePointerDown);
      interactionElement.removeEventListener('pointermove', handlePointerMove);
      interactionElement.removeEventListener('pointerup', finishPointer);
      interactionElement.removeEventListener('pointercancel', finishPointer);
      interactionElement.removeEventListener('keydown', handleKeydown);
      interactionElement.classList.remove('dragging');
      group.traverse((object) => {
        object.geometry?.dispose?.();
        if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose?.());
        else object.material?.dispose?.();
      });
      texture.dispose();
      renderer.dispose();
      if (ownsCanvas) canvas.remove();
    }

    resize();
    updateTexture();
    if (options.autoRotate) startAutoRotate();

    return {
      THREE,
      renderer,
      scene,
      camera,
      group,
      canvas,
      textureCanvas,
      texture,
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
