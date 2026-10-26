(function () {
  'use strict';
  var root = document.getElementById('word-demo');
  if (!root) return;
  var scene = root.querySelector('[data-demo-scene]');
  var svg = root.querySelector('[data-flights]');
  var pauseButton = root.querySelector('[data-demo-pause]');
  var replayButton = root.querySelector('[data-demo-replay]');
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var paused = reduced.matches;
  var introLocked = !!document.documentElement?.classList.contains('intro-lock');
  var visible = false;
  var elapsed = 0;
  var inputInterval = 1800;
  var typingInterval = 105;
  var inputFlightDuration = 1850;
  var playbackSpeed = Number(root.getAttribute('data-demo-speed')) || 1;
  var storyFinished = false;
  var rotationDelay = 500;
  window.addEventListener('message', function (event) {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    if (event.data && event.data.type === 'wolkenworte:preview-rotation-delay') {
      var delay = Number(event.data.delay);
      if (Number.isFinite(delay)) {
        rotationDelay = Math.max(0, Math.min(1500, delay));
        setStoryFinished(false);
        elapsed = cupOnly ? mugStart : 0;
        previousCycleTime = cycleDuration;
        previous = null;
        if (!reduced.matches) draw();
        updatePlayback();
      }
      return;
    }
    if (!event.data || event.data.type !== 'wolkenworte:preview-speed') return;
    var value = Number(event.data.speed);
    if (Number.isFinite(value)) playbackSpeed = Math.max(.1, Math.min(3, value));
  });
  var cupOnly = typeof URLSearchParams !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === 'mug';
  var requestedMotion = (typeof URLSearchParams !== 'undefined' ? new URLSearchParams(window.location.search).get('motion') : null) || root.getAttribute('data-demo-motion');
  var motionStudy = ['clockwork', 'ribbon', 'ribbon-airy', 'magnetic', 'magnetic-vortex', 'magnetic-wave', 'magnetic-braid', 'magnetic-glide', 'magnetic-fan', 'magnetic-orbit'].indexOf(requestedMotion) >= 0 ? requestedMotion : null;
  var ribbonMotion = motionStudy === 'ribbon' || motionStudy === 'ribbon-airy';
  var airyRibbon = motionStudy === 'ribbon-airy';
  var atmosphereFade = airyRibbon ? .55 : .80;
  var atmosphereBlur = airyRibbon ? 1 : 1.8;
  var magneticMotion = !!motionStudy && motionStudy.indexOf('magnetic') === 0;
  var calmMotion = ['magnetic-glide', 'magnetic-fan', 'magnetic-orbit'].indexOf(motionStudy) >= 0;
  var openingDelay = motionStudy ? 650 : 6000;
  var revealDuration = motionStudy ? 2600 : 6000;
  function smoother(value) { var v = Math.max(0, Math.min(1, value)); return v * v * v * (v * (v * 6 - 15) + 10); }
  var fullSequence = typeof URLSearchParams !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === 'full';
  if (fullSequence) {
    document.documentElement.classList.add('demo-cup-only');
    document.documentElement.classList.add('demo-full-sequence');
  }
  var singleWord = typeof URLSearchParams !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === 'word';
  if (cupOnly) {
    elapsed = 15000;
    document.documentElement.classList.add('demo-cup-only');
  }
  var previous = null;
  var frame = null;
  var cycleDuration = motionStudy ? 33500 : 62000;
  var mugStart = 15000;
  var mugFlightDuration = 11000;
  var stickers = [];
  var cupMaterials = [];
  var words = ['Abenteuer', 'Lachen', 'Freundschaft', '🥂', 'Glück', '❤️'];
  var mugStage = root.querySelector('[data-demo-mug]');
  var mugHost = root.querySelector('[data-demo-mug-viewer]');
  var mugViewer = null;
  var mugTextured = false;
  var mugRotationStarted = false;
  var previousCycleTime = 0;
  var frameBounds = null;
  var ns = 'http://www.w3.org/2000/svg';
  function t(value) { return window.WolkenworteI18n ? window.WolkenworteI18n.t(value) : value; }
  function waitingDrift(index, age) {
    if (airyRibbon && mugFlights && mugFlights[index] && mugFlights[index].geometry && mugStage) {
      var bounds = frameBounds.stage;
      var sceneBounds = frameBounds.scene;
      var origin = mugFlights[index].geometry.start;
      // A soft radial push clears the centre without sorting words into lanes.
      // Inner words travel further; existing outer words retain their spacing.
      var centreX = bounds.left - sceneBounds.left + bounds.width / 2;
      var centreY = bounds.top - sceneBounds.top + bounds.height * .48;
      var dx = origin.x - centreX;
      var dy = origin.y - centreY;
      var nx = dx / Math.max(1, bounds.width * .5);
      var ny = dy / Math.max(1, bounds.height * .38);
      var distance = Math.hypot(nx, ny);
      var direction = distance > .08 ? Math.atan2(ny, nx) : index * 2.39996;
      var innerPush = Math.exp(-distance * distance * 1.8);
      var pushX = dx * .16 + Math.cos(direction) * bounds.width * .30 * innerPush;
      var pushY = dy * .10 + Math.sin(direction) * bounds.height * .17 * innerPush;
      var seconds = Math.max(0, age) / 1000;
      var gather = smoother(seconds / 1.9);
      // One slow lateral curl, with zero velocity at departure from the cloud.
      // Keep this drift non-periodic so the words float without bobbing.
      var curl = Math.sin(Math.PI * gather) * Math.sin(Math.PI * gather);
      var tangent = Math.min(bounds.width, bounds.height) * .025 * curl;
      return { x: pushX * gather - Math.sin(direction) * tangent,
        y: pushY * gather + Math.cos(direction) * tangent };
    }
    if (calmMotion) return { x: 0, y: 0 };
    var seconds = Math.max(0, age) / 1000;
    var onset = Math.min(1, seconds / 1.8);
    onset = onset * onset * (3 - 2 * onset);
    return { x: Math.sin(seconds * .65 + index * 1.9) * 30 * onset,
      y: Math.sin(seconds * .55 + index * 2.4) * 22 * onset };
  }
  // Match angular travel to arrival time: every word meets the right-front
  // quadrant, then the completed print turns back to its centred hero pose.
  function printFacingYaw(age, firstAngle, lastAngle, flightDuration, sweepDuration, delay) {
    var span = Math.max(.01, lastAngle - firstAngle);
    var firstLanding = 650 + flightDuration;
    var lastLanding = firstLanding + sweepDuration;
    var velocity = -span / sweepDuration;
    var firstYaw = .55 - firstAngle;
    var lastYaw = .55 - lastAngle;
    var finalYaw = -(firstAngle + lastAngle) / 2;
    function hermite(t, a, b, va, vb, duration) {
      return (2*t*t*t-3*t*t+1)*a + (t*t*t-2*t*t+t)*va*duration +
        (-2*t*t*t+3*t*t)*b + (t*t*t-t*t)*vb*duration;
    }
    // Words depart at 650 ms; the preview controls the following delay. Start from
    // the matching orientation so it turns in one direction immediately,
    // rather than barely moving and reversing before the first landing.
    var rotationStart = 650 + (delay == null ? 500 : delay);
    var rampDuration = 600;
    var initialYaw = firstYaw - velocity * (firstLanding - rotationStart - rampDuration / 2);
    if (age <= rotationStart) return initialYaw;
    if (age < rotationStart + rampDuration) {
      var ramp = (age - rotationStart) / rampDuration;
      return initialYaw + velocity * rampDuration * (ramp*ramp*ramp - .5*ramp*ramp*ramp*ramp);
    }
    if (age < firstLanding) return firstYaw + (age - firstLanding) * velocity;
    if (age <= lastLanding) return firstYaw + (age - firstLanding) * velocity;
    return hermite(Math.min(1, (age - lastLanding) / 3200), lastYaw, finalYaw, velocity, 0, 3200);
  }
  function magneticOffset(kind, progress, rank) {
    // Zero position and velocity at either end preserve the source handoff
    // and the cup-relative landing, even for the more expressive paths.
    var envelope = Math.pow(Math.sin(Math.PI * progress), 2);
    var phase = progress * Math.PI * 2;
    // Calm studies use one continuous approach with no vertical excursion,
    // repeated oscillation, spring or overshoot. All still meet the same cup.
    if (kind === 'magnetic-glide') return { x: 0, y: 0, z: envelope * .25 };
    if (kind === 'magnetic-fan') return {
      x: envelope * ((rank % 5) - 2) * .28, y: 0, z: envelope * .45 };
    if (kind === 'magnetic-orbit') return {
      x: envelope * .8, y: 0, z: envelope * .65 };
    if (kind === 'magnetic-vortex') return {
      x: envelope * Math.cos(phase + rank * .45) * 1.15,
      y: envelope * Math.sin(phase + rank * .45) * .95,
      z: envelope * 1.55 };
    if (kind === 'magnetic-wave') return {
      x: envelope * .45,
      y: envelope * (.55 + Math.sin(phase - rank * .65) * 1.15),
      z: envelope * (1.15 + Math.cos(phase - rank * .65) * .3) };
    if (kind === 'magnetic-braid') return {
      x: envelope * Math.sin(phase) * (rank % 2 ? -1 : 1) * 1.25,
      y: envelope * (.5 + Math.cos(phase) * (rank % 2 ? -.55 : .55)),
      z: envelope * (1.15 + Math.sin(phase) * (rank % 2 ? -.45 : .45)) };
    return { x: envelope * .35, y: envelope * .65, z: envelope };
  }
  function element(name, attributes, parent) {
    var node = document.createElementNS(ns, name);
    Object.keys(attributes).forEach(function (key) { node.setAttribute(key, attributes[key]); });
    parent.appendChild(node);
    return node;
  }
  var phones = words.map(function (word, index) {
    var group = element('g', { opacity: 0 }, svg);
    var trail = element('path', { fill: 'none', stroke: '#e3b51b', 'stroke-width': 1.2, 'stroke-linecap': 'round', opacity: .35 }, group);
    var sparks = Array.from({ length: 12 }, function (_, i) {
      return element('path', { d: 'M-3 0H3M0-3V3', stroke: i % 2 ? '#e3b51b' : '#bd2055', 'stroke-width': 1.4, 'stroke-linecap': 'round', fill: 'none' }, group);
    });
    var flying = element('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'demo-flight-word' }, group);
    return { word: word, index: index, phone: root.querySelector('[data-phone="' + index + '"]'),
      participant: root.querySelector('[data-participant="' + index + '"]'),
      typed: root.querySelector('[data-typing="' + index + '"]'), send: root.querySelector('[data-send="' + index + '"]'),
      target: root.querySelector('[data-arrival="' + index + '"]'), group: group, trail: trail, sparks: sparks,
      flying: flying, geometry: null };
  });
  var cloudNodes = Array.from(root.querySelectorAll('.demo-cloud > span'));
  var printSources = cloudNodes;
  var mugFlights = printSources.map(function (node, index) {
    var group = element('g', { opacity: 0, class: 'demo-mug-flight' }, svg);
    var trail = element('path', { fill: 'none', stroke: '#e3b51b', 'stroke-width': 1.3, 'stroke-linecap': 'round', opacity: .25 }, group);
    var sparks = Array.from({ length: 8 }, function (_, sparkIndex) {
      var star = sparkIndex % 3 === 0;
      return element('path', {
        d: star ? 'M0-4C.45-1 .9-.45 3 0 .9.45 .45 1 0 4-.45 1-.9.45-3 0-.9-.45-.45-1 0-4Z' : 'M1 0A1 1 0 1 1-1 0A1 1 0 1 1 1 0Z',
        fill: star ? '#e3b51b' : '#bd2055', stroke: star ? '#fff4d8' : 'none',
        'stroke-width': .35, class: 'demo-mug-spark'
      }, group);
    });
    var flying = element('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'demo-flight-word' }, group);
    return { node: node, index: index, group: group, trail: trail, sparks: sparks, flying: flying, geometry: null };
  });
  var revealMagic = element('g', { opacity: 0, 'pointer-events': 'none' }, svg);
  var revealHalo = element('ellipse', { fill: 'none', stroke: '#e3b51b', 'stroke-width': 2, opacity: 0 }, revealMagic);
  var revealSparks = Array.from({ length: 24 }, function (_, index) {
    return element('path', { d: index % 3 ? 'M1.2 0A1.2 1.2 0 1 1-1.2 0A1.2 1.2 0 1 1 1.2 0Z' : 'M0-5Q.7-.7 4 0Q.7.7 0 5Q-.7.7-4 0Q-.7-.7 0-5Z',
      fill: index % 2 ? '#37a257' : '#914bc4', class: 'demo-reveal-spark' }, revealMagic);
  });
  function drawRevealMagic(age) {
    var progress = Math.max(0, Math.min(1, age / 3000));
    var strength = progress <= 0 || progress >= 1 ? 0 : Math.pow(Math.sin(Math.PI * progress), 1.4);
    revealMagic.setAttribute('opacity', String(strength));
    if (!strength || !mugStage) return;
    var bounds = frameBounds.stage;
    var sceneBounds = frameBounds.scene;
    var cx = bounds.left - sceneBounds.left + bounds.width * .5;
    var cy = bounds.top - sceneBounds.top + bounds.height * (.72 - progress * .40);
    var radius = bounds.width * (.52 - progress * .12);
    revealHalo.setAttribute('cx', cx); revealHalo.setAttribute('cy', cy);
    revealHalo.setAttribute('rx', radius); revealHalo.setAttribute('ry', radius * .22);
    revealHalo.setAttribute('opacity', String(strength * .35));
    revealSparks.forEach(function (spark, index) {
      var angle = index * 2.39996 + progress * Math.PI * 1.6;
      var orbit = radius * (.75 + (index % 4) * .09);
      var x = cx + Math.cos(angle) * orbit;
      var y = cy + Math.sin(angle) * orbit * .30 + Math.sin(index * 7.3) * bounds.height * .14;
      var twinkle = .35 + .65 * Math.pow(Math.sin(progress * 9 + index * 1.7), 2);
      spark.setAttribute('transform', 'translate(' + x + ' ' + y + ') rotate(' + (progress * 80 + index * 17) + ') scale(' + (.35 + twinkle * .65) + ')');
      spark.setAttribute('opacity', String(twinkle));
    });
  }
  function drawMugTexture(ctx, area) {
    var placements = [
      [.31,.28,.105], [.55,.25,.072], [.72,.31,.058], [.40,.46,.05], [.61,.48,.075],
      [.28,.61,.055], [.50,.65,.065], [.72,.63,.047], [.35,.78,.044], [.61,.79,.05],
      [.82,.47,.04], [.18,.43,.04], [.18,.75,.038], [.82,.74,.04], [.48,.16,.05], [.50,.91,.04]
    ];
    ctx.save();
    ctx.beginPath(); ctx.rect(area.offsetX, area.offsetY, area.printWidth, area.printHeight); ctx.clip();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    cloudNodes.forEach(function (node, index) {
      var placement = placements[index % placements.length];
      var style = window.getComputedStyle(node);
      ctx.fillStyle = style.color || '#914bc4';
      ctx.font = 'italic 600 ' + Math.round(area.printHeight * placement[2]) + 'px Georgia, serif';
      ctx.fillText(t(node.textContent.trim()), area.offsetX + area.printWidth * placement[0], area.offsetY + area.printHeight * placement[1]);
    });
    ctx.restore();
  }
  function setStoryFinished(enabled) {
    storyFinished = enabled;
    if (replayButton) replayButton.hidden = !enabled;
    if (pauseButton) pauseButton.hidden = enabled || reduced.matches;
    if (mugHost) mugHost.setAttribute('tabindex', '-1');
  }
  function ensureMug() {
    if (mugViewer || !mugHost || !window.Mug3DViewer || !window.THREE) return;
    if (document.fonts && document.fonts.status === 'loading') return;
    try {
      var product = window.wolkenworteLandingMugProduct;
      if (!product || !window.PrintfulProductModel) return;
      mugViewer = window.Mug3DViewer.create({
        THREE: window.THREE,
        host: mugHost,
        // Align the catalog mesh with the original animation's cup axis and
        // cylindrical word strips; the story keeps its own motion and layout.
        product: Object.assign({}, product, { previewMesh: Object.assign({}, product.previewMesh, {
          rotateY: 180, diameter: product.size.diameterCm,
        }) }),
        positionY: .1,
        initialRotationY: 0,
        autoRotateDurationMs: 8000,
        maxPixelRatio: 1.5,
        // Bound fragment work even in the full-window comparison preview.
        maxRenderPixels: 1200000,
        framingFill: function () { return .82; },
      });
      mugViewer.ready.then(function (ready) {
        if (!ready) return;
        mugViewer.group.scale.setScalar(1.216);
        mugViewer.group.traverse(function (object) {
          var materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
          materials.forEach(function (material) {
            if (cupMaterials.indexOf(material) >= 0) return;
            material.transparent = true;
            material.opacity = 0;
            material.needsUpdate = true;
            cupMaterials.push(material);
          });
        });
        buildStickers();
        mugViewer.render();
      });
      mugHost.setAttribute('tabindex', '-1');
      mugViewer.render();
    } catch (_) { mugViewer = null; }
  }
  // One optimized layout is both the destination of every flight and the
  // finished print. Curved strips attach left-to-right to the ceramic surface.
  function buildStickers() {
    var THREE = window.THREE;
    if (!window.DesignLayout || !cloudNodes.length) return;
    var ctx = document.createElement('canvas').getContext('2d');
    var design = printSources.map(function (node, index) {
      return { id: String(index), text: t(node.textContent.trim()), x: 1350, y: 525,
        fontSize: Math.max(60, parseFloat(window.getComputedStyle(node).fontSize) * 7) *
          (node.classList.contains('cloud-friendship') ? 1.25 : 1),
        angle: 0, color: window.getComputedStyle(node).color, fontWeight: 500, fontStyle: 'italic' };
    });
    if (singleWord) {
      design = [Object.assign({}, design[0], { x: 1350, y: 525, fontSize: 210 })];
    } else {
      // Place every landing within the visible sweep of the handle's half-turn.
      design = window.DesignLayout.optimizeDesign(design, [{ x: 700, y: 45, width: 1300, height: 960 }], ctx, { fontFamily: 'Georgia' });
    }
    function inkBox(item) {
      ctx.font = 'italic 500 ' + item.fontSize + 'px "Playfair Display"';
      var metric = ctx.measureText(item.text);
      var width = Math.max(metric.width, (metric.actualBoundingBoxLeft || 0) + (metric.actualBoundingBoxRight || 0));
      var height = (metric.actualBoundingBoxAscent || item.fontSize) + (metric.actualBoundingBoxDescent || item.fontSize * .25);
      return { x: item.x, y: item.y, width: width + 16, height: height + 16 };
    }
    // Verify the actual browser glyph bounds, not just the layout estimates.
    // Keep a small ceramic gap around every word, including italic overhangs.
    for (var attempt = 0; attempt < 80; attempt++) {
      var boxes = design.map(inkBox);
      var collision = boxes.some(function (box, i) {
        return boxes.slice(i + 1).some(function (other) {
          return Math.abs(box.x - other.x) < (box.width + other.width) / 2 &&
            Math.abs(box.y - other.y) < (box.height + other.height) / 2;
        });
      });
      if (!collision) break;
      design.forEach(function (item) { item.fontSize *= .97; });
    }
    // Counter the 5% smaller cup so the printed glyphs retain their screen
    // size, while their existing centres move closer together with the cup.
    design.forEach(function (item) { item.fontSize /= .95; });
    // Keep the compensated font sizes: resolve any newly touching pair by
    // moving its centres slightly rather than shrinking the words again.
    for (var pass = 0; pass < 80; pass++) {
      var expandedBoxes = design.map(inkBox);
      var moved = false;
      expandedBoxes.forEach(function (a, i) {
        expandedBoxes.slice(i + 1).forEach(function (b, relative) {
          var j = i + 1 + relative;
          var overlapX = (a.width + b.width) / 2 - Math.abs(a.x - b.x);
          var overlapY = (a.height + b.height) / 2 - Math.abs(a.y - b.y);
          if (overlapX <= 0 || overlapY <= 0) return;
          var axis = overlapX < overlapY ? 'x' : 'y';
          var shift = ((axis === 'x' ? overlapX : overlapY) + 2) / 2;
          var direction = a[axis] <= b[axis] ? -1 : 1;
          design[i][axis] += direction * shift;
          design[j][axis] -= direction * shift;
          a[axis] = design[i][axis]; b[axis] = design[j][axis];
          moved = true;
        });
      });
      if (!moved) break;
    }
    var ordered = design.slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    var ranks = {};
    ordered.forEach(function (item, rank) { ranks[item.id] = rank; });
    mugHost.setAttribute('data-print-layout', JSON.stringify(design.map(function (item) {
      return Object.assign({ text: item.text, rank: ranks[item.id] }, inkBox(item));
    })));
    stickers = design.map(function (item) {
      var image = document.createElement('canvas');
      var ink = image.getContext('2d');
      var font = 'italic 500 ' + item.fontSize + 'px "Playfair Display"';
      ink.font = font;
      var metrics = ink.measureText(item.text);
      var left = metrics.actualBoundingBoxLeft || 0;
      var right = metrics.actualBoundingBoxRight || metrics.width;
      var ascent = metrics.actualBoundingBoxAscent || item.fontSize;
      var descent = metrics.actualBoundingBoxDescent || item.fontSize * .25;
      var width = Math.ceil(left + right + 16);
      var height = Math.ceil(ascent + descent + 16);
      image.width = width; image.height = height;
      ink.font = font; ink.textAlign = 'left'; ink.textBaseline = 'alphabetic'; ink.fillStyle = item.color;
      ink.fillText(item.text, 8 + left, 8 + ascent);
      var texture = new THREE.CanvasTexture(image); texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      // Match the product preview: oblique print needs anisotropic filtering
      // so mipmaps do not blur tall glyphs as they wrap around the cup sides.
      texture.anisotropy = mugViewer.texture.anisotropy;
      var geometry = new THREE.PlaneGeometry(width / 2700 * 22.86, height / 1050 * 8.89, 60, 1);
      var original = geometry.attributes.position.array.slice();
      var mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture, transparent: true, alphaTest: .01, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      var blurUniform = { value: new THREE.Vector2(0, 0) };
      mesh.material.onBeforeCompile = function (shader) {
        shader.uniforms.wordBlur = blurUniform;
        shader.fragmentShader = 'uniform vec2 wordBlur;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
          '#ifdef USE_MAP\n' +
          'vec4 wordInk = texture2D(map, vMapUv) * 0.4;\n' +
          'wordInk += texture2D(map, vMapUv + vec2(wordBlur.x, 0.0)) * 0.15;\n' +
          'wordInk += texture2D(map, vMapUv - vec2(wordBlur.x, 0.0)) * 0.15;\n' +
          'wordInk += texture2D(map, vMapUv + vec2(0.0, wordBlur.y)) * 0.15;\n' +
          'wordInk += texture2D(map, vMapUv - vec2(0.0, wordBlur.y)) * 0.15;\n' +
          'diffuseColor *= wordInk;\n#endif');
      };
      mesh.visible = false; mesh.renderOrder = 2;
      // The geometry moves far beyond its original plane bounds during flight.
      // Static frustum bounds must never cull an otherwise visible word.
      mesh.frustumCulled = false;
      mugViewer.group.add(mesh);
      var source = printSources[Number(item.id)].getBoundingClientRect();
      var bounds = scene.getBoundingClientRect();
      var canvasRect = mugViewer.canvas.getBoundingClientRect();
      var ray = new THREE.Vector3(
        ((source.left + source.width / 2 - canvasRect.left) / canvasRect.width) * 2 - 1,
        1 - ((source.top + source.height / 2 - canvasRect.top) / canvasRect.height) * 2,
        .5).unproject(mugViewer.camera).sub(mugViewer.camera.position).normalize();
      var startWorld = mugViewer.camera.position.clone().addScaledVector(ray, (8 - mugViewer.camera.position.z) / ray.z);
      return { rank: ranks[item.id], mesh: mesh, original: original, angle: 1.62 + (item.x / 2700 - .5) * (22.86 / 4.1), y: ( .5 - item.y / 1050) * 8.89, width: width / 2700 * 22.86,
        startWorld: startWorld, blurUniform: blurUniform, textureWidth: width, textureHeight: height,
        startScale: source.width / Math.max(1, (width / 2700 * 22.86 * 1.216) * canvasRect.height / (2 * Math.tan(mugViewer.camera.fov * Math.PI / 360) * (mugViewer.camera.position.z - 8))),
        startX: ((source.left + source.width / 2 - bounds.left) / bounds.width - .5) * 22,
        startY: (.5 - (source.top + source.height / 2 - bounds.top) / bounds.height) * 15 };
    });
  }
  function matchSourceScale(sticker, sourceWidth, canvasBounds, camera) {
    // Measure the actual projected plane at departure. Window resizing can
    // change camera framing after the sticker's initial geometry was built.
    var halfWidth = sticker.width * 1.216 / 2;
    var left = sticker.startWorld.clone();
    var right = sticker.startWorld.clone();
    left.x -= halfWidth; right.x += halfWidth;
    left.project(camera); right.project(camera);
    var projectedWidth = Math.abs(right.x - left.x) * canvasBounds.width / 2;
    return sourceWidth / Math.max(.001, projectedWidth);
  }
  function attachSticker(sticker, progress, phaseAge) {
    // Hidden and finished strips need no vertex uploads. A replay's zero
    // progress clears the settled flag before the next departure.
    if (progress <= 0) {
      sticker.mesh.visible = false;
      sticker.settled = false;
      return;
    }
    if (progress >= 1 && sticker.settled) return;
    var attachment = Math.max(0, Math.min(1, (progress - .30) / .70));
    var smoothAttachment = attachment * attachment * attachment * (attachment * (attachment * 6 - 15) + 10);
    var amount = -.08 + smoothAttachment * 1.08;
    if (motionStudy) amount = -.08 + smoother((progress - .38) / .62) * 1.08;
    var positions = sticker.mesh.geometry.attributes.position;
    // The single-word study stays on the visible face. Avoid ceramic depth
    // clipping at the moving hinge, which can cut a white slit through glyphs.
    sticker.mesh.material.depthTest = progress >= 1;
    var revealProgress = Math.max(0, Math.min(1, phaseAge / revealDuration));
    revealProgress = revealProgress * revealProgress * (3 - 2 * revealProgress);
    var refocusStart = Math.max(openingDelay, sticker.departureAge || 0);
    var focus = Math.max(0, Math.min(1, (phaseAge - refocusStart) / (motionStudy ? 1800 : 4000)));
    focus = focus * focus * (3 - 2 * focus);
    var duration = sticker.duration || 6500;
    var sharedOpacity = 1 - revealProgress * atmosphereFade;
    // Exactly one copy owns the word on each frame. Crossfading a frozen
    // DOM word with an accelerating mesh made the departure look like a jerk.
    sticker.mesh.material.opacity = sharedOpacity + focus * (1 - sharedOpacity);

    // The soft sampling radius falls continuously to zero during departure.
    var blurPixels = revealProgress * atmosphereBlur;
    var textureBlur = blurPixels * sticker.textureWidth / Math.max(1, sticker.sourceWidth || 100);
    sticker.blurUniform.value.set((1 - focus) * textureBlur / sticker.textureWidth, (1 - focus) * textureBlur / sticker.textureHeight);
    // Moving words render above both the ceramic and finished print.
    sticker.mesh.renderOrder = progress < 1 ? 10 : 2;
    var startVertex = new window.THREE.Vector3();
    // Object3D.worldToLocal updates ancestors and inverts a matrix per call.
    // All vertices in this strip share one inverse for this frame.
    var inverseWorld = new window.THREE.Matrix4().copy(mugViewer.group.matrixWorld).invert();
    var origin = sticker.startWorld.clone();
    // Continue the incoming drift instead of freezing its velocity at handoff.
    if (sticker.startVelocity) {
      var carryTime = progress * duration / 1000;
      var carryFade = Math.pow(1 - Math.min(1, progress / .60), 2);
      origin.addScaledVector(sticker.startVelocity, carryTime * carryFade);
    }
    if (singleWord) origin.set(4.5, 2, 8);
    // These trajectory terms belong to the whole strip, not each vertex.
    // In particular magneticOffset used to allocate 122 identical objects.
    var arc = Math.pow(Math.sin(Math.PI * progress), 2);
    var sweep = motionStudy === 'clockwork' ? (sticker.rank % 2 ? 1 : -1) : 1;
    var pathOffset = magneticMotion ? magneticOffset(motionStudy, progress, sticker.rank) : {
      x: arc * sweep * (airyRibbon ? .8 : 1.25),
      y: arc * (airyRibbon ? 1.2 + sticker.y * .4 : ribbonMotion ? 1.8 : .65), z: arc * 2 };
    for (var vertex = 0; vertex < positions.count; vertex++) {
      var offset = vertex * 3;
      var x = sticker.original[offset];
      // Local text x runs from the first glyph edge to the last. Every word
      // uses this same attachment direction, independent of its wrap angle.
      var across = Math.max(0, Math.min(1, x / sticker.width + .5));
      // The leading edge arrives first while the trailing edge is still flying.
      // A continuous arrival wave overlaps approach and attachment.
      var travel = Math.max(0, Math.min(1, progress / (.55 + across * .05)));
      var ease = travel * travel * travel * (travel * (travel * 6 - 15) + 10);
      var textScale = sticker.startScale * (1 - ease) + ease;
      var angle = sticker.angle + x / 4.1;
      var endX = Math.sin(angle) * 4.115;
      var endY = sticker.y + sticker.original[offset + 1];
      var endZ = Math.cos(angle) * 4.115;
      var contactX = (amount - .5) * sticker.width;
      var freeLength = Math.max(0, x - contactX);
      if (freeLength > 0 && !magneticMotion) {
        // A rounded moving hinge preserves the strip length. The free letters
        // leave the surface at 65 degrees instead of stretching radially.
        var bendRadius = .16;
        var bendAngle = 65 * Math.PI / 180;
        var curvedLength = Math.min(freeLength, bendRadius * bendAngle);
        var theta = curvedLength / bendRadius;
        var straightLength = freeLength - curvedLength;
        var along = bendRadius * Math.sin(theta) + straightLength * Math.cos(theta);
        var lift = bendRadius * (1 - Math.cos(theta)) + straightLength * Math.sin(theta);
        var contactAngle = sticker.angle + contactX / 4.1;
        var freeX = Math.sin(contactAngle) * lift + Math.cos(contactAngle) * along;
        var freeZ = Math.cos(contactAngle) * lift - Math.sin(contactAngle) * along;
        // The contact point belongs to the rotating cup. The free strip keeps
        // its world-space heading: subtract cup yaw, fading compensation to
        // zero across the rounded hinge so the attached letters stay fixed.
        var hingeBlend = Math.min(1, freeLength / (bendRadius * bendAngle));
        hingeBlend = hingeBlend * hingeBlend * (3 - 2 * hingeBlend);
        var counterYaw = - (mugViewer.group.rotation.y - (sticker.departureYaw == null ? 0 : sticker.departureYaw)) * hingeBlend;
        var cosine = Math.cos(counterYaw), sine = Math.sin(counterYaw);
        endX = Math.sin(contactAngle) * 4.115 + freeX * cosine + freeZ * sine;
        endZ = Math.cos(contactAngle) * 4.115 - freeX * sine + freeZ * cosine;
      }
      startVertex.copy(origin);
      startVertex.x += x * 1.216 * textScale;
      startVertex.y += sticker.original[offset + 1] * 1.216 * textScale;
      startVertex.applyMatrix4(inverseWorld);
      if (motionStudy) {
        // A zero-slope envelope joins both endpoints without a positional snap.
        // The moving destination carries the cup's velocity into final contact.
        var landing = smoother(progress / (ribbonMotion ? .88 + across * .12 : 1));
        positions.setXYZ(vertex,
          startVertex.x * (1 - landing) + endX * landing + pathOffset.x,
          startVertex.y * (1 - landing) + endY * landing + pathOffset.y,
          startVertex.z * (1 - landing) + endZ * landing + pathOffset.z);
      } else positions.setXYZ(vertex,
        startVertex.x * (1 - ease) + endX * ease,
        startVertex.y * (1 - ease) + endY * ease,
        startVertex.z * (1 - ease) + endZ * ease);
    }
    sticker.settled = progress >= 1;
    positions.needsUpdate = true;
    sticker.mesh.visible = progress > 0;
  }
  function measure() {
    var bounds = scene.getBoundingClientRect();
    svg.setAttribute('viewBox', '0 0 ' + bounds.width + ' ' + bounds.height);
    phones.forEach(function (phone) {
      var input = phone.phone.querySelector('.demo-phone-input').getBoundingClientRect();
      var target = phone.target.getBoundingClientRect();
      var start = { x: input.left + input.width / 2 - bounds.left, y: input.top + input.height / 2 - bounds.top };
      var end = { x: target.left + target.width / 2 - bounds.left, y: target.top + target.height / 2 - bounds.top };
      var control = { x: start.x + (end.x - start.x) * .35, y: Math.min(start.y, end.y) - bounds.height * (phone.index < 2 ? .10 : .19) };
      phone.geometry = { start: start, end: end, control: control, font: parseFloat(window.getComputedStyle(phone.target).fontSize), color: window.getComputedStyle(phone.target).color || '#e3b51b' };
      phone.trail.setAttribute('d', 'M' + start.x + ',' + start.y + ' Q' + control.x + ',' + control.y + ' ' + end.x + ',' + end.y);
      phone.trail.setAttribute('pathLength', '1');
    });
    if (mugStage) {
      var mugBounds = mugStage.getBoundingClientRect();
      mugFlights.forEach(function (flight, index) {
        var startBounds = flight.node.getBoundingClientRect();
        var angle = -1.05 + (index % 6) * .42;
        var ring = index % 2 ? .19 : .28;
        var start = { x: startBounds.left + startBounds.width / 2 - bounds.left, y: startBounds.top + startBounds.height / 2 - bounds.top };
        var end = { x: mugBounds.left - bounds.left + mugBounds.width * (.5 + Math.sin(angle) * ring), y: mugBounds.top - bounds.top + mugBounds.height * (.48 + Math.cos(angle) * ring * .48) };
        var control = { x: start.x + (end.x - start.x) * .55 + Math.sin(index * 1.7) * bounds.width * .05, y: Math.min(start.y, end.y) - bounds.height * (.08 + (index % 3) * .025) };
        flight.geometry = { start: start, end: end, control: control, font: parseFloat(window.getComputedStyle(flight.node).fontSize), color: window.getComputedStyle(flight.node).color || '#914bc4' };
        flight.trail.setAttribute('d', 'M' + start.x + ',' + start.y + ' Q' + control.x + ',' + control.y + ' ' + end.x + ',' + end.y);
        flight.trail.setAttribute('pathLength', '1');
      });
    }
    mugViewer?.resize();
  }
  function point(geometry, progress) {
    var q = 1 - progress;
    return { x: q * q * geometry.start.x + 2 * q * progress * geometry.control.x + progress * progress * geometry.end.x,
      y: q * q * geometry.start.y + 2 * q * progress * geometry.control.y + progress * progress * geometry.end.y };
  }
  function draw() {
    // Read layout before any style/geometry writes. In particular, radial
    // drift must not force a layout once per word on WebKit.
    frameBounds = {
      scene: scene.getBoundingClientRect(),
      stage: mugStage ? mugStage.getBoundingClientRect() : null,
      canvas: mugViewer ? mugViewer.canvas.getBoundingClientRect() : null,
      sources: cloudNodes.map(function (node) { return node.getBoundingClientRect(); })
    };
    if (storyFinished) return;
    if (cupOnly && elapsed >= cycleDuration) elapsed = mugStart;
    var cycleTime = elapsed % cycleDuration;
    if (cycleTime < previousCycleTime) {
      mugTextured = false;
      mugRotationStarted = false;
      if (mugViewer) mugViewer.updateTexture(function () {});
      stickers.forEach(function (sticker) { sticker.mesh.visible = false; sticker.departureAge = null; sticker.previousFacePosition = null; sticker.previousReadyPosition = null; });
    }
    previousCycleTime = cycleTime;
    var activeIndex = Math.min(words.length - 1, Math.floor(cycleTime / inputInterval));
    phones.forEach(function (phone) {
      var inputGroup = phone.index;
      var age = cycleTime - inputGroup * inputInterval;
      var text = t(phone.word);
      var letters = Array.from(text);
      var emptyPause = phone.index === 0 ? 0 : 600;
      var typingAge = age - emptyPause;
      var typingDuration = emptyPause + letters.length * typingInterval + 400;
      var flightAge = age - typingDuration;
      var progress = Math.max(0, Math.min(1, flightAge / inputFlightDuration));
      var flying = flightAge >= 0 && progress < 1;
      var arrivedNow = flightAge >= inputFlightDuration;
      var typed = typingAge < 0 ? '' : letters.slice(0, Math.min(letters.length, Math.floor(typingAge / typingInterval))).join('');
      var active = inputGroup === activeIndex && age >= 0 && flightAge < 2300;
      phone.phone.classList.toggle('is-active', active);
      phone.phone.classList.toggle('is-first-composer', phone.index === 0);
      phone.participant.classList.toggle('is-active', active);
      phone.participant.classList.toggle('has-contributed', arrivedNow);
      if (phone.typed.textContent !== typed) phone.typed.textContent = typed;
      phone.send.classList.toggle('is-sending', flightAge >= -180 && flightAge < 450);
      phone.group.setAttribute('opacity', flying ? '1' : '0');
      // Visibility belongs to this cycle only, never to a previous send.
      phone.target.style.opacity = arrivedNow ? '1' : '0';
      // Brief arrival emphasis while retaining the shared layout and word positions.
      var pulse = arrivedNow ? Math.max(0, 1 - (flightAge - inputFlightDuration) / 650) : 0;
      phone.target.style.filter = pulse ? 'drop-shadow(0 0 ' + (pulse * 9) + 'px #914bc4)' : '';
      if (!flying || !phone.geometry) return;
      var geometry = phone.geometry;
      var position = point(geometry, progress);
      phone.flying.textContent = text;
      phone.flying.style.fill = geometry.color;
      phone.flying.setAttribute('x', position.x);
      phone.flying.setAttribute('y', position.y);
      phone.flying.setAttribute('font-size', (Math.min(16, geometry.font) * (1 - progress) + geometry.font * progress).toFixed(2));
      phone.trail.setAttribute('stroke-dasharray', progress + ' 1');
      phone.trail.setAttribute('opacity', String(.3 * Math.sin(progress * Math.PI)));
      phone.sparks.forEach(function (spark, index) {
        var lag = (index + 1) * .018;
        var sparkProgress = Math.max(0, progress - lag);
        var p = point(geometry, sparkProgress);
        var spread = Math.sin(index * 9.2 + progress * 15) * (4 + index * .8);
        var sparkle = .4 + .6 * Math.abs(Math.sin(progress * 15 + index * 2));
        spark.setAttribute('transform', 'translate(' + (p.x + spread) + ' ' + (p.y + Math.cos(index * 5) * 8) + ') scale(' + (sparkle * (1 - index / 16)) + ')');
        spark.setAttribute('opacity', progress > lag ? String(.8 * (1 - index / 14) * Math.min(1, (1 - progress) * 10)) : '0');
      });
    });
    var mugAge = cycleTime - mugStart;
    if (airyRibbon && mugAge > 0) mugAge *= 1.3;
    var mugProgress = Math.max(0, Math.min(1, mugAge / mugFlightDuration));
    var attachmentAge = Math.max(0, mugAge - (cupOnly ? 2500 : 0));
    var attachmentDuration = cupOnly ? 4400 : 11000;
    var attachmentProgress = Math.min(1, attachmentAge / attachmentDuration);
    var mugActive = mugAge >= 0;
    drawRevealMagic(mugAge);
    if (mugStage) {
      var reveal = mugActive ? Math.max(0, Math.min(1, mugAge / revealDuration)) : 0;
      reveal = reveal * reveal * (3 - 2 * reveal);
      // Fade the composited layer too: this includes the backing glow and
      // guarantees no opaque frame can escape while WebGL prepares materials.
      mugStage.style.opacity = String(mugActive ? smoother(mugAge / 1300) : 0);
      cupMaterials.forEach(function (material) { material.opacity = reveal; });
      mugStage.style.transform = 'none';
      // Words share the WebGL canvas with the ceramic: never blur this canvas,
      // otherwise a fully opaque moving word still looks faded and indistinct.
      if (mugViewer) mugViewer.canvas.style.filter = 'none';
    }
    if (mugActive) {
      ensureMug();
      if (mugViewer) {
        mugViewer.stopAutoRotate();
        // Negative yaw moves the visible front surface to the viewer's left.
        // Handle begins on the left, travels behind the ceramic, and ends on
        // the right. Ease the last part of the half-turn to a complete stop.
        var turnDuration = 24000;
        var turnTime = Math.max(0, Math.min(1, mugAge / turnDuration));
        var stopStart = .82;
        var turnDistance;
        if (turnTime <= stopStart) turnDistance = turnTime;
        else {
          var brake = (turnTime - stopStart) / (1 - stopStart);
          turnDistance = stopStart + (1 - stopStart) * (brake - brake * brake / 2);
        }
        var firstPrintAngle = stickers.length ? Math.min.apply(null, stickers.map(function (item) { return item.angle; })) : 0;
        var lastPrintAngle = stickers.length ? Math.max.apply(null, stickers.map(function (item) { return item.angle; })) : 0;
        var studyFlightDuration = airyRibbon ? 2800 : ribbonMotion ? 3600 : magneticMotion ? 2800 : 3200;
        var studySweepDuration = airyRibbon ? 9500 : magneticMotion ? 5000 : 7000;
        mugViewer.group.rotation.y = motionStudy
          ? printFacingYaw(mugAge, firstPrintAngle, lastPrintAngle, studyFlightDuration, studySweepDuration, rotationDelay)
          : -Math.PI * turnDistance / (.5 + stopStart / 2);
        mugViewer.group.updateMatrixWorld(true);
        stickers.forEach(function (sticker, index) {
          var angle = sticker.angle - sticker.width / (2 * 4.1);
          var edge = new window.THREE.Vector3(Math.sin(angle) * 4.115, sticker.y, Math.cos(angle) * 4.115);
          mugViewer.group.localToWorld(edge);
          var center = new window.THREE.Vector3(0, sticker.y, 0);
          mugViewer.group.localToWorld(center);
          var radius = 4.115 * mugViewer.group.scale.x;
          var right = new window.THREE.Vector3(center.x + radius, center.y, center.z).project(mugViewer.camera);
          var left = new window.THREE.Vector3(center.x - radius, center.y, center.z).project(mugViewer.camera);
          edge.project(mugViewer.camera);
          var facePosition = (right.x - edge.x) / (right.x - left.x);
          var frontFacing = Math.cos(angle + mugViewer.group.rotation.y) > 0;
          var crossed = sticker.previousFacePosition != null && sticker.previousFacePosition < .30 && facePosition >= .30;
          var alreadyAtStart = sticker.previousFacePosition == null && facePosition >= .30 && facePosition <= .65;
          var readyAfterFade = mugAge >= 6000 && sticker.previousReadyPosition == null && facePosition >= .30;
          var studyDeparture = openingDelay + (sticker.angle - firstPrintAngle) / Math.max(.01, lastPrintAngle - firstPrintAngle) * studySweepDuration;
          var readyToDepart = motionStudy ? mugAge >= studyDeparture : mugAge >= 6000 && frontFacing && (crossed || readyAfterFade);
          if (sticker.departureAge == null && readyToDepart) {
            // Capture the drifting cloud position at departure, so the 3D
            // flight starts exactly where the viewer last saw this word.
            var source = frameBounds.sources[index];
            var canvasRect = frameBounds.canvas || mugViewer.canvas.getBoundingClientRect();
            var ray = new window.THREE.Vector3(
              ((source.left + source.width / 2 - canvasRect.left) / canvasRect.width) * 2 - 1,
              1 - ((source.top + source.height / 2 - canvasRect.top) / canvasRect.height) * 2,
              .5).unproject(mugViewer.camera).sub(mugViewer.camera.position).normalize();
            sticker.startWorld = mugViewer.camera.position.clone().addScaledVector(ray, (8 - mugViewer.camera.position.z) / ray.z);
            sticker.startScale = matchSourceScale(sticker, source.width, canvasRect, mugViewer.camera);
            var currentDrift = waitingDrift(index, mugAge - (airyRibbon ? 0 : openingDelay));
            var nextDrift = waitingDrift(index, mugAge - (airyRibbon ? 0 : openingDelay) + 50);
            var nextRay = new window.THREE.Vector3(
              ((source.left + source.width / 2 + nextDrift.x - currentDrift.x - canvasRect.left) / canvasRect.width) * 2 - 1,
              1 - ((source.top + source.height / 2 + nextDrift.y - currentDrift.y - canvasRect.top) / canvasRect.height) * 2,
              .5).unproject(mugViewer.camera).sub(mugViewer.camera.position).normalize();
            var nextWorld = mugViewer.camera.position.clone().addScaledVector(nextRay, (8 - mugViewer.camera.position.z) / nextRay.z);
            sticker.startVelocity = nextWorld.sub(sticker.startWorld).multiplyScalar(20);
            var sourceScreenX = source.left + source.width / 2;
            var sourceScreenY = source.top + source.height / 2;
            var destinationX = canvasRect.left + (edge.x + 1) * canvasRect.width / 2;
            var destinationY = canvasRect.top + (1 - edge.y) * canvasRect.height / 2;
            var distance = Math.hypot(destinationX - sourceScreenX, destinationY - sourceScreenY);
            sticker.duration = motionStudy ? studyFlightDuration : Math.max(6500, Math.min(11000, distance / 40 * 1000 / .55));
            var waitingBlend = Math.max(0, Math.min(1, mugAge / revealDuration));
            waitingBlend = waitingBlend * waitingBlend * (3 - 2 * waitingBlend);
            sticker.initialOpacity = 1 - waitingBlend * atmosphereFade;
            sticker.initialBlur = waitingBlend * atmosphereBlur;
            sticker.sourceWidth = source.width;
            sticker.departureAge = mugAge;
            sticker.departureYaw = mugViewer.group.rotation.y;
            sticker.triggerPosition = facePosition;
          }
          sticker.previousFacePosition = facePosition;
          if (mugAge >= 6000) sticker.previousReadyPosition = facePosition;
        });
        var departureSnapshot = JSON.stringify(stickers.map(function (sticker, index) {
          return { word: cloudNodes[index].textContent.trim(), time: sticker.departureAge, position: sticker.triggerPosition };
        }));
        if (mugHost.getAttribute('data-departures') !== departureSnapshot) mugHost.setAttribute('data-departures', departureSnapshot);
      }
    }
    cloudNodes.forEach(function (node, index) {
      var departure = stickers[index] && stickers[index].departureAge;
      var displayedDrift = waitingDrift(index, Math.max(0, (departure == null ? mugAge : departure) - (airyRibbon ? 0 : openingDelay)));
      node.style.transform = mugActive ? 'translate(-50%, -50%) translate3d(' + displayedDrift.x.toFixed(3) + 'px,' + displayedDrift.y.toFixed(3) + 'px,0)' : '';
      if (mugActive) {
        var waitingBlend = Math.max(0, Math.min(1, mugAge / revealDuration));
        waitingBlend = waitingBlend * waitingBlend * (3 - 2 * waitingBlend);
        var handedOff = departure != null && mugAge > departure;
        var sticker = stickers[index];
        node.style.opacity = handedOff ? '0' : String(1 - waitingBlend * atmosphereFade);
        node.style.filter = 'blur(' + (waitingBlend * atmosphereBlur) + 'px)';
      }
      else {
        node.style.filter = '';
        if (!node.classList.contains('cloud-arrival')) node.style.opacity = '';
      }
    });
    mugFlights.forEach(function (flight, index) {
      if (singleWord && index > 0) { flight.group.setAttribute('opacity', '0'); return; }
      var rank = stickers[index] ? stickers[index].rank : index;
      var stagger = rank / Math.max(1, mugFlights.length - 1) * .58;
      var sticker = stickers[index];
      var progress = sticker && sticker.departureAge != null ? Math.max(0, Math.min(1, (mugAge - sticker.departureAge) / (sticker.duration || 6500))) : 0;
      if (sticker && mugViewer) {
        attachSticker(sticker, mugActive ? progress : 0, mugActive ? mugAge : 0);
      }
      var flying = mugActive && progress > 0 && progress < .95 && flight.geometry;
      if (!flying) flight.history = [];
      flight.group.setAttribute('opacity', flying ? '1' : '0');
      if (!flying) return;
      var canvasBounds = frameBounds.canvas || mugViewer.canvas.getBoundingClientRect();
      var sceneBounds = frameBounds.scene;
      var position;
      // The word itself is the WebGL mesh; the SVG text remains hidden.
      // Do not compute a second, invisible quadratic flight and font size.
      flight.flying.setAttribute('opacity', '0');
      // Trail follows the actual animated mesh, including the cup's rotation.
      if (sticker && mugViewer) {
        var vertices = sticker.mesh.geometry.attributes.position;
        var center = new window.THREE.Vector3();
        for (var v = 0; v < vertices.count; v++) {
          center.x += vertices.getX(v); center.y += vertices.getY(v); center.z += vertices.getZ(v);
        }
        center.divideScalar(vertices.count);
        mugViewer.group.localToWorld(center); center.project(mugViewer.camera);
        position = { x: canvasBounds.left - sceneBounds.left + (center.x + 1) * canvasBounds.width / 2,
          y: canvasBounds.top - sceneBounds.top + (1 - center.y) * canvasBounds.height / 2 };
      }
      flight.history = flight.history || [];
      flight.history.push(position);
      if (flight.history.length > 38) flight.history.shift();
      flight.trail.setAttribute('d', flight.history.map(function (p, i) { return (i ? 'L' : 'M') + p.x + ',' + p.y; }).join(' '));
      flight.trail.setAttribute('stroke-dasharray', '1 0');
      var motionGlow = (motionStudy ? .20 : .5) * Math.pow(Math.sin(progress * Math.PI), .7);
      flight.trail.setAttribute('opacity', String(motionGlow));
      flight.sparks.forEach(function (spark, sparkIndex) {
        var lag = (sparkIndex + 1) * .025;
        var sparkProgress = Math.max(0, progress - lag);
        var p = flight.history[Math.max(0, flight.history.length - 1 - sparkIndex * 4)] || position;
        var spread = Math.sin(index * 3.1 + sparkIndex * 2.7 + progress * 7) * (2 + sparkIndex * .65);
        var twinkle = Math.pow(.5 + .5 * Math.sin(progress * 19 - sparkIndex * 1.7), 2);
        var size = (.45 + twinkle * .85) * (1 - sparkIndex / 13);
        spark.setAttribute('transform', 'translate(' + (p.x + spread) + ' ' + (p.y + Math.cos(sparkIndex * 4.2 + progress * 3) * (3 + sparkIndex * .5)) + ') rotate(' + (sparkIndex * 23 + progress * 35) + ') scale(' + size + ')');
        spark.setAttribute('opacity', String(Math.min(1, Math.max(0, motionGlow) * 2.8 * (.45 + twinkle * .55) * (1 - sparkIndex / 11))));
      });
    });
    if (mugViewer && mugActive) {
      // The landing demo is decorative; replay is its only interactive control.
      mugViewer.render({ updateInteractionRegion: false });
      var lastLandingAge = stickers.reduce(function (latest, sticker) {
        return Math.max(latest, (sticker.departureAge || 0) + (sticker.duration || 6500));
      }, 0);
      if (motionStudy && stickers.length && stickers.every(function (sticker) { return sticker.departureAge != null; }) &&
          mugAge >= lastLandingAge + 3200) setStoryFinished(true);
    }
  }
  function tick(now) {
    if (previous !== null) elapsed += Math.max(0, now - previous) * playbackSpeed;
    previous = now;
    draw();
    frame = storyFinished ? null : window.requestAnimationFrame(tick);
  }
  function updatePlayback() {
    if (pauseButton) {
      pauseButton.hidden = storyFinished || reduced.matches;
      pauseButton.setAttribute('aria-label', t(paused ? 'Vorschau abspielen' : 'Vorschau pausieren'));
      pauseButton.setAttribute('aria-pressed', String(paused));
    }
    window.cancelAnimationFrame(frame);
    frame = null;
    previous = null;
    if (mugViewer && (paused || introLocked || !visible || document.hidden)) mugViewer.stopAutoRotate();
    if (!storyFinished && !paused && !introLocked && visible && !document.hidden) frame = window.requestAnimationFrame(tick);
  }
  function staticScene() {
    setStoryFinished(false);
    revealMagic.setAttribute('opacity', '0');
    cloudNodes.forEach(function (node) { node.style.transform = ''; node.style.filter = ''; node.style.opacity = ''; });
    if (mugStage) { mugStage.style.opacity = '0'; mugStage.style.transform = ''; }
    mugFlights.forEach(function (flight) { flight.group.setAttribute('opacity', '0'); });
    phones.forEach(function (phone) {
      phone.phone.classList.remove('is-active');
      phone.participant.classList.remove('is-active');
      phone.participant.classList.add('has-contributed');
      phone.target.style.opacity = '1'; phone.target.style.filter = '';
      phone.typed.textContent = t(phone.word); phone.group.setAttribute('opacity', '0');
      phone.send.classList.remove('is-sending');
    });
  }
  function replayStory() {
    setStoryFinished(false);
    elapsed = cupOnly ? mugStart : 0;
    previousCycleTime = cycleDuration;
    previous = null;
    paused = reduced.matches;
    if (reduced.matches) staticScene(); else draw();
    updatePlayback();
  }
  replayButton?.addEventListener('click', replayStory);
  pauseButton?.addEventListener('click', function () {
    paused = !paused;
    updatePlayback();
  });
  root.classList.add('is-animated');
  document.querySelectorAll('[data-try-demo]').forEach(function (link) {
    link.addEventListener('click', function (event) {
      event.preventDefault();
      root.scrollIntoView({ behavior: reduced.matches ? 'instant' : 'smooth', block: 'center' });
      if (!reduced.matches) replayStory();
    });
  });
  // The restored intro owns the screen until its fade completes. Keep the
  // story at its opening frame rather than letting it play behind the video.
  if (window.MutationObserver && document.documentElement) {
    new window.MutationObserver(function () {
      var nextLocked = document.documentElement.classList.contains('intro-lock');
      if (nextLocked === introLocked) return;
      introLocked = nextLocked;
      updatePlayback();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }
  document.addEventListener('visibilitychange', updatePlayback);
  reduced.addEventListener('change', function () {
    paused = reduced.matches;
    if (reduced.matches) staticScene();
    updatePlayback();
  });
  window.addEventListener('wolkenworte:localechange', function (event) {
    setStoryFinished(false);
    elapsed = 0;
    measure();
    if (reduced.matches) staticScene(); else draw();
    updatePlayback();
  });
  if ('ResizeObserver' in window) new ResizeObserver(measure).observe(scene);
  else window.addEventListener('resize', measure);
  if (document.fonts) document.fonts.ready.then(measure);
  measure();
  if (reduced.matches) staticScene(); else draw();
  if ('IntersectionObserver' in window) {
    // A sliver below the copy must not start the story before visitors see it.
    new IntersectionObserver(function (entries) {
      var entry = entries[0];
      // Compare with the portion that can actually fit in a short viewport.
      var availableHeight = entry.rootBounds ? entry.rootBounds.height : window.innerHeight;
      var sceneHeight = entry.boundingClientRect ? entry.boundingClientRect.height : 0;
      var threshold = sceneHeight > 0 && availableHeight > 0
        ? Math.min(.65, availableHeight / sceneHeight * .65) : .65;
      visible = entry.isIntersecting && entry.intersectionRatio >= threshold;
      if (visible) ensureMug();
      updatePlayback();
    }, { threshold: [0, .1, .2, .3, .4, .5, .65, 1] }).observe(scene);
  } else { visible = true; }
  updatePlayback();
})();
