(function () {
  'use strict';
  const report = document.createElement('section');
  report.id = 'scroll-regression';
  report.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:99999;max-width:calc(100vw - 24px);max-height:50vh;overflow:auto;padding:16px;border:1px solid #ddd;border-radius:12px;background:white;color:#400f26;font:14px system-ui';
  const run = document.createElement('button');
  run.textContent = 'Scroll-Verhalten prüfen';
  const output = document.createElement('pre');
  output.style.cssText = 'white-space:pre-wrap;margin-bottom:0';
  report.append(run, output);
  document.body.append(report);

  run.addEventListener('click', async () => {
    const results = [], fixtures = [];
    const check = (name, passed) => {
      results.push(`${passed ? 'PASS' : 'FAIL'} ${name}`);
      if (!passed) throw new Error(name);
    };
    const dialog = () => {
      const element = document.createElement('dialog');
      element.innerHTML = '<button type="button">Test</button>';
      document.body.append(element);
      fixtures.push(element);
      return element;
    };
    const overflow = () => getComputedStyle(document.documentElement).overflowY;
    const wheel = async element => {
      // User input follows the mutation-observer checkpoint after a surface
      // opens. Synthetic events must allow that checkpoint as well.
      await Promise.resolve();
      const box = element.getBoundingClientRect();
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100,
        clientX: box.left + 5, clientY: box.top + 5 });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const before = { y: scrollY, x: scrollX, width: document.body.getBoundingClientRect().width, overflow: overflow() };
    try {
      check('Kein Dialog vor dem Test geöffnet', !document.querySelector('dialog:modal'));
      const outer = dialog(), inner = dialog();
      outer.showModal();
      check('Modal sperrt den Seitenhintergrund', overflow() === 'hidden' && getComputedStyle(document.body).overflowY === 'hidden');
      check('Keine Verschiebung durch die Scrollleiste', document.body.getBoundingClientRect().width === before.width);
      check('Scrollen auf dem Hintergrund wird abgefangen', await wheel(document.body));
      inner.showModal();
      check('Verschachtelter Dialog bleibt gesperrt', overflow() === 'hidden');
      outer.close();
      check('Schließen des unteren Dialogs entsperrt nicht', overflow() === 'hidden');
      inner.close();
      check('Letzter geschlossener Dialog gibt Scrollen frei', overflow() === before.overflow);
      outer.showModal(); inner.showModal(); inner.close();
      check('Schließen des oberen Dialogs entsperrt nicht', overflow() === 'hidden');
      outer.close();
      outer.show();
      check('Eingebetteter Dialog sperrt die Seite nicht', overflow() === before.overflow);
      outer.close();
      if (typeof outer.showPopover === 'function') {
        outer.setAttribute('popover', 'manual');
        outer.showPopover();
        check('Popover sperrt Scrollen außerhalb nicht', overflow() === before.overflow && !await wheel(document.body));
        check('Nicht scrollbar: Scrollen über Popover bleibt enthalten', await wheel(outer));
        const list = document.createElement('div');
        list.style.cssText = 'height:60px;overflow-y:auto';
        list.innerHTML = '<div style="height:600px">Test</div>';
        outer.append(list);
        check('Innere Scrollbereiche enthalten beide Achsen', getComputedStyle(list).overscrollBehaviorX === 'contain' && getComputedStyle(list).overscrollBehaviorY === 'contain');
        check('Liste lässt internes Scrollen zu', !await wheel(list));
        list.scrollTop = list.scrollHeight;
        check('Unteres Listenende gibt Scrollen nicht weiter', await wheel(list));
        outer.hidePopover();
      }
      check('Seitenposition bleibt erhalten', scrollY === before.y && scrollX === before.x);
    } catch (error) {
      if (!results.at(-1)?.startsWith('FAIL')) results.push(`FAIL ${error.message}`);
    } finally {
      fixtures.forEach(element => element.remove());
      const failed = results.some(result => result.startsWith('FAIL'));
      output.textContent = `${failed ? 'FAIL' : 'PASS'} ${results.length} scroll checks\n${results.join('\n')}`;
      report.dataset.result = failed ? 'fail' : 'pass';
    }
  });
})();
