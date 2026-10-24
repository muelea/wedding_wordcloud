(function () {
  'use strict';
  var root = document.getElementById('word-demo');
  if (!root) return;
  var scene = root.querySelector('[data-demo-scene]');
  var svg = root.querySelector('[data-flights]');
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var paused = reduced.matches;
  var visible = false;
  var elapsed = 0;
  var previous = null;
  var frame = null;
  var cycleDuration = 16000;
  var words = ['Abenteuer', 'Lachen', 'Freundschaft', '🥂', 'Gesundheit', '❤️'];
  var ns = 'http://www.w3.org/2000/svg';
  function t(value) { return window.WolkenworteI18n ? window.WolkenworteI18n.t(value) : value; }
  function element(name, attributes, parent) {
    var node = document.createElementNS(ns, name);
    Object.keys(attributes).forEach(function (key) { node.setAttribute(key, attributes[key]); });
    parent.appendChild(node);
    return node;
  }
  var phones = words.map(function (word, index) {
    var group = element('g', { opacity: 0 }, svg);
    var trail = element('path', { fill: 'none', stroke: '#c1922f', 'stroke-width': 1.2, 'stroke-linecap': 'round', opacity: .35 }, group);
    var sparks = Array.from({ length: 12 }, function (_, i) {
      return element('path', { d: 'M-3 0H3M0-3V3', stroke: i % 2 ? '#c1922f' : '#d1607e', 'stroke-width': 1.4, 'stroke-linecap': 'round', fill: 'none' }, group);
    });
    var flying = element('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'demo-flight-word' }, group);
    return { word: word, index: index, phone: root.querySelector('[data-phone="' + index + '"]'),
      participant: root.querySelector('[data-participant="' + index + '"]'),
      typed: root.querySelector('[data-typing="' + index + '"]'), send: root.querySelector('[data-send="' + index + '"]'),
      target: root.querySelector('[data-arrival="' + index + '"]'), group: group, trail: trail, sparks: sparks,
      flying: flying, geometry: null };
  });
  function measure() {
    var bounds = scene.getBoundingClientRect();
    svg.setAttribute('viewBox', '0 0 ' + bounds.width + ' ' + bounds.height);
    phones.forEach(function (phone) {
      var input = phone.phone.querySelector('.demo-phone-input').getBoundingClientRect();
      var target = phone.target.getBoundingClientRect();
      var start = { x: input.left + input.width / 2 - bounds.left, y: input.top + input.height / 2 - bounds.top };
      var end = { x: target.left + target.width / 2 - bounds.left, y: target.top + target.height / 2 - bounds.top };
      var control = { x: start.x + (end.x - start.x) * .35, y: Math.min(start.y, end.y) - bounds.height * (phone.index < 2 ? .10 : .19) };
      phone.geometry = { start: start, end: end, control: control, font: parseFloat(window.getComputedStyle(phone.target).fontSize), color: window.getComputedStyle(phone.target).color || '#f77500' };
      phone.trail.setAttribute('d', 'M' + start.x + ',' + start.y + ' Q' + control.x + ',' + control.y + ' ' + end.x + ',' + end.y);
      phone.trail.setAttribute('pathLength', '1');
    });
  }
  function point(geometry, progress) {
    var q = 1 - progress;
    return { x: q * q * geometry.start.x + 2 * q * progress * geometry.control.x + progress * progress * geometry.end.x,
      y: q * q * geometry.start.y + 2 * q * progress * geometry.control.y + progress * progress * geometry.end.y };
  }
  function draw() {
    var activeIndex = Math.min(words.length - 1, Math.floor((elapsed % cycleDuration) / 2200));
    phones.forEach(function (phone) {
      var age = (elapsed % cycleDuration) - phone.index * 2200;
      var text = t(phone.word);
      var letters = Array.from(text);
      var typingDuration = letters.length * 105 + 400;
      var flightAge = age - typingDuration;
      var progress = Math.max(0, Math.min(1, flightAge / 1850));
      var flying = flightAge >= 0 && progress < 1;
      var arrivedNow = flightAge >= 1850;
      var typed = age < 0 ? '' : letters.slice(0, Math.min(letters.length, Math.floor(age / 105))).join('');
      var active = phone.index === activeIndex && flightAge < 2300;
      phone.phone.classList.toggle('is-active', active);
      phone.participant.classList.toggle('is-active', active);
      phone.participant.classList.toggle('has-contributed', arrivedNow);
      if (phone.typed.textContent !== typed) phone.typed.textContent = typed;
      phone.send.classList.toggle('is-sending', flightAge >= -180 && flightAge < 450);
      phone.group.setAttribute('opacity', flying ? '1' : '0');
      // Visibility belongs to this cycle only, never to a previous send.
      phone.target.style.opacity = arrivedNow ? '1' : '0';
      // Brief arrival emphasis while retaining the shared layout and word positions.
      var pulse = arrivedNow ? Math.max(0, 1 - (flightAge - 1850) / 650) : 0;
      phone.target.style.filter = pulse ? 'drop-shadow(0 0 ' + (pulse * 9) + 'px #dba8bd)' : '';
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
  }
  function tick(now) {
    if (previous !== null) elapsed += Math.min(50, now - previous);
    previous = now;
    draw();
    frame = window.requestAnimationFrame(tick);
  }
  function updatePlayback() {
    window.cancelAnimationFrame(frame);
    frame = null;
    previous = null;
    if (!paused && visible && !document.hidden) frame = window.requestAnimationFrame(tick);
  }
  function staticScene() {
    phones.forEach(function (phone) {
      phone.phone.classList.remove('is-active');
      phone.participant.classList.remove('is-active');
      phone.participant.classList.add('has-contributed');
      phone.target.style.opacity = '1'; phone.target.style.filter = '';
      phone.typed.textContent = t(phone.word); phone.group.setAttribute('opacity', '0');
      phone.send.classList.remove('is-sending');
    });
  }
  root.classList.add('is-animated');
  document.querySelectorAll('[data-try-demo]').forEach(function (link) {
    link.addEventListener('click', function (event) {
      event.preventDefault();
      root.scrollIntoView({ behavior: reduced.matches ? 'instant' : 'smooth', block: 'center' });
      if (!reduced.matches) { paused = false; updatePlayback(); }
    });
  });
  document.addEventListener('visibilitychange', updatePlayback);
  reduced.addEventListener('change', function () {
    paused = reduced.matches;
    if (reduced.matches) staticScene();
    updatePlayback();
  });
  window.addEventListener('wolkenworte:localechange', function (event) {
    var locale = event.detail && event.detail.locale;
    document.querySelectorAll('[data-workflow-locale-screenshot]').forEach(function (image) {
      var nextSource = image.getAttribute('data-workflow-src-' + locale);
      if (nextSource) image.setAttribute('src', nextSource);
    });
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
    new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; updatePlayback(); }, { threshold: .15 }).observe(scene);
  } else { visible = true; }
  updatePlayback();
})();
