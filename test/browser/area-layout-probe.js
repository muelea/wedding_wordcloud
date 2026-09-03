'use strict';

// Local fixture only: exercise real controller actions and Fabric serialization.
(function () {
  const run = document.createElement('button');
  run.type = 'button';
  run.textContent = 'Check repeated fit-area clicks';
  run.style.cssText = 'position:fixed;right:16px;top:90px;z-index:1000;padding:12px;background:white;color:black';
  const report = document.createElement('pre');
  report.style.cssText = 'white-space:pre-wrap;padding:16px;background:white;color:black';
  report.id = 'area-layout-report';
  document.body.append(run, report);
  run.addEventListener('click', async () => {
    run.disabled = true;
    const results = [];
    const check = (name, pass) => results.push({ name, pass: Boolean(pass) });
    const frame = async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    };
    let initial;
    try {
      if (!workspaceReady) throw new Error('Wait for the configurator.');
      initial = mugEditor.getState();
      const action = [...placementOptions.children].find(button =>
        button.textContent.includes(WolkenworteI18n.t('Fläche optimal nutzen')));
      const stableClicks = async name => {
        const before = JSON.stringify(mugEditor.getState());
        const revision = designRevision;
        for (let count = 0; count < 5; count++) { action.click(); await frame(); }
        check(name + ': same exact design and history after 5 clicks', JSON.stringify(mugEditor.getState()) === before);
        check(name + ': no dirty-state change', designRevision === revision);
      };
      await stableClicks('Initial');
      mugEditor.setState(JSON.parse(JSON.stringify(initial)));
      await frame();
      await stableClicks('Restored');
      await WolkenworteEmoji.preloadTexts(['Liebe ❤️']);
      for (const font of DesignFonts.FONTS) {
        await ensureDesignFonts([font.key]);
        mugEditor.setDesign(initial.design.map((item, index) => ({ ...item,
          text: index === 0 ? 'Liebe ❤️' : item.text, fontFamily: font.key,
          x: 250, y: 250, fontSize: 80, angle: index % 5 === 4 ? -90 : 0,
        })), { resetHistory: true });
        action.click(); await frame();
        check(font.key + ': content retained', mugEditor.getDesign().length === initial.design.length &&
          mugEditor.getDesign().every(item => item.fontFamily === font.key));
        await stableClicks(font.key);
      }
    } catch (error) { results.push({ name: 'Probe failed', pass: false, message: error.message }); }
    finally {
      if (initial) mugEditor.setState(initial);
      report.textContent = JSON.stringify({ passed: results.every(result => result.pass), results }, null, 2);
      run.disabled = false;
    }
  });
})();
