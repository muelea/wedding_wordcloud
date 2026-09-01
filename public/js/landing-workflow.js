(function () {
  'use strict';

  var stories = document.querySelectorAll('[data-workflow]');
  if (!stories.length) return;

  document.documentElement.classList.add('workflow-scroll-ready');

  stories.forEach(function (workflow) {
    var triggers = Array.prototype.slice.call(workflow.querySelectorAll('[data-workflow-trigger]'));
    var steps = triggers.map(function (trigger) { return trigger.closest('.workflow-step'); });
    var panels = Array.prototype.slice.call(workflow.querySelectorAll('[data-workflow-panel]'));
    var stage = workflow.querySelector('[data-workflow-stage]');
    var sticky = workflow.querySelector('[data-workflow-sticky]');
    var desktopLayout = window.matchMedia('(min-width: 1051px)');
    var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    var scrubDurationMs = 240;
    var activeIndex = 0;
    var animationFrame = 0;
    var targetProgress = 0;
    var renderedProgress = 0;
    var previousFrameTime = 0;
    var needsScrollMeasurement = true;
    var hasRenderedProgress = false;

    if (!triggers.length || triggers.length !== panels.length || !stage || !sticky) return;

    function clamp(value, minimum, maximum) {
      var min = typeof minimum === 'number' ? minimum : 0;
      var max = typeof maximum === 'number' ? maximum : 1;
      return Math.max(min, Math.min(value, max));
    }

    function selectStep(nextIndex) {
      activeIndex = Math.max(0, Math.min(nextIndex, triggers.length - 1));
      triggers.forEach(function (trigger, index) {
        var isActive = index === activeIndex;
        var state = index < activeIndex ? 'completed' : isActive ? 'active' : 'upcoming';
        trigger.setAttribute('data-active', String(isActive));
        trigger.setAttribute('data-state', state);
        if (steps[index]) steps[index].setAttribute('data-state', state);
        trigger.tabIndex = desktopLayout.matches && index <= activeIndex ? 0 : -1;
        if (desktopLayout.matches && isActive) trigger.setAttribute('aria-current', 'step');
        else trigger.removeAttribute('aria-current');
      });

      panels.forEach(function (panel, index) {
        var isActive = index === activeIndex;
        var state = index < activeIndex ? 'completed' : isActive ? 'active' : 'upcoming';
        panel.setAttribute('data-active', String(isActive));
        panel.setAttribute('data-state', state);
        panel.setAttribute('aria-hidden', desktopLayout.matches ? String(!isActive) : 'false');
      });
    }

    function applyProgress(nextProgress) {
      var progress = clamp(nextProgress, 0, triggers.length - 1);
      var nextActiveIndex = Math.round(progress);
      if (nextActiveIndex !== activeIndex) selectStep(nextActiveIndex);

      triggers.forEach(function (trigger, index) {
        var reveal = reducedMotion.matches
          ? Number(index <= activeIndex)
          : index === 0
            ? 1
            : clamp(progress - index + 1);
        var opacity = index < activeIndex
          ? .62
          : index === activeIndex
            ? .55 + reveal * .45
            : reveal * .5;

        trigger.style.setProperty('--workflow-step-opacity', opacity.toFixed(3));
        trigger.style.setProperty('--workflow-step-y', ((1 - reveal) * 28).toFixed(2) + 'px');
      });

      panels.forEach(function (panel, index) {
        var reveal = reducedMotion.matches
          ? Number(index <= activeIndex)
          : index === 0
            ? 1
            : clamp(progress - index + 1);
        var depth = Math.max(0, (reducedMotion.matches ? activeIndex : progress) - index);
        var visibleDepth = Math.min(depth, 1);
        var opacity = clamp(reveal * 1.65) * clamp(3.15 - depth);

        panel.style.setProperty('--workflow-panel-opacity', opacity.toFixed(3));
        panel.style.setProperty('--workflow-panel-y', ((1 - reveal) * 104).toFixed(2) + '%');
        panel.style.setProperty('--workflow-panel-stack-y', '0px');
        panel.style.setProperty('--workflow-panel-scale', (1 - .1 * visibleDepth).toFixed(4));
        panel.style.setProperty('--workflow-panel-brightness', (1 - .62 * visibleDepth).toFixed(3));
        panel.style.setProperty('--workflow-panel-grayscale', (.75 * visibleDepth).toFixed(3));
        panel.style.zIndex = String(index + 1);
      });
    }

    function measureScrollProgress() {
      var stickyBounds = sticky.getBoundingClientRect();
      var stickyTop = Number.parseFloat(window.getComputedStyle(sticky).top);
      var storyBounds = workflow.getBoundingClientRect();
      var scrollRange = Math.max(1, workflow.offsetHeight - stickyBounds.height);
      var scrolledDistance = Number.isFinite(stickyTop) ? stickyTop - storyBounds.top : -storyBounds.top;
      return clamp(scrolledDistance / scrollRange) * (triggers.length - 1);
    }

    function renderScrollProgress(frameTime) {
      animationFrame = 0;
      if (!desktopLayout.matches) {
        previousFrameTime = 0;
        return;
      }

      if (needsScrollMeasurement) {
        targetProgress = measureScrollProgress();
        needsScrollMeasurement = false;
      }

      if (!hasRenderedProgress || reducedMotion.matches) {
        renderedProgress = targetProgress;
        hasRenderedProgress = true;
      } else {
        var elapsed = previousFrameTime ? Math.min(frameTime - previousFrameTime, 64) : 1000 / 60;
        var retention = Math.pow(.05, elapsed / scrubDurationMs);
        renderedProgress = targetProgress + (renderedProgress - targetProgress) * retention;
        if (Math.abs(targetProgress - renderedProgress) < .001) renderedProgress = targetProgress;
      }

      previousFrameTime = frameTime;
      applyProgress(renderedProgress);

      if (!reducedMotion.matches && Math.abs(targetProgress - renderedProgress) >= .001) {
        animationFrame = window.requestAnimationFrame(renderScrollProgress);
      } else {
        previousFrameTime = 0;
      }
    }

    function requestScrollUpdate() {
      if (!desktopLayout.matches) return;
      needsScrollMeasurement = true;
      if (!animationFrame) animationFrame = window.requestAnimationFrame(renderScrollProgress);
    }

    function clearAnimatedStyles() {
      triggers.forEach(function (trigger) {
        trigger.style.removeProperty('--workflow-step-opacity');
        trigger.style.removeProperty('--workflow-step-y');
      });
      panels.forEach(function (panel) {
        panel.style.removeProperty('--workflow-panel-opacity');
        panel.style.removeProperty('--workflow-panel-y');
        panel.style.removeProperty('--workflow-panel-stack-y');
        panel.style.removeProperty('--workflow-panel-scale');
        panel.style.removeProperty('--workflow-panel-brightness');
        panel.style.removeProperty('--workflow-panel-grayscale');
        panel.style.removeProperty('z-index');
      });
    }

    function syncLayout() {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      previousFrameTime = 0;
      needsScrollMeasurement = true;
      hasRenderedProgress = false;

      panels.forEach(function (panel, index) {
        if (desktopLayout.matches) stage.appendChild(panel);
        else if (steps[index]) steps[index].appendChild(panel);
      });

      triggers.forEach(function (trigger) {
        trigger.toggleAttribute('disabled', !desktopLayout.matches);
      });

      selectStep(activeIndex);
      if (desktopLayout.matches) requestScrollUpdate();
      else clearAnimatedStyles();
    }

    triggers.forEach(function (trigger, index) {
      trigger.addEventListener('click', function () {
        if (!desktopLayout.matches || triggers.length < 2) return;
        var stickyTop = Number.parseFloat(window.getComputedStyle(sticky).top) || 0;
        var storyTop = window.scrollY + workflow.getBoundingClientRect().top;
        var scrollRange = Math.max(1, workflow.offsetHeight - sticky.offsetHeight);
        window.scrollTo({
          top: storyTop - stickyTop + scrollRange * (index / (triggers.length - 1)),
          behavior: reducedMotion.matches ? 'auto' : 'smooth'
        });
      });
    });

    window.addEventListener('scroll', requestScrollUpdate, { passive: true });
    window.addEventListener('resize', requestScrollUpdate, { passive: true });
    window.addEventListener('pageshow', requestScrollUpdate);
    window.addEventListener('wolkenworte:localechange', requestScrollUpdate);
    desktopLayout.addEventListener('change', syncLayout);
    reducedMotion.addEventListener('change', requestScrollUpdate);
    syncLayout();
  });
})();
