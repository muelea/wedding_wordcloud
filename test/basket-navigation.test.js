'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const Baskets=require('../public/js/basket-navigation');

test('browser basket navigation retains workspace isolation and omits expired or invalid references',t=>{
  const dom=new JSDOM('<section data-browser-baskets></section>',{url:'https://wolkenworte.test/'});
  t.after(()=>dom.window.close());
  const storage=dom.window.localStorage,first='a'.repeat(22),second='b'.repeat(22),expired='c'.repeat(22);
  storage.setItem(`wolkenworte-order:${'d'.repeat(22)}`,'broken JSON');
  for(const slug of [first,second,expired]){
    storage.setItem(`wolkenworte-order:${slug}`,JSON.stringify([{id:'x'.repeat(16)}, {id:'x'.repeat(16)}, {id:'invalid'}]));
    storage.setItem(`wolkenworte-order:${slug}:expires`,String(slug===expired?1:Date.now()+60000));
  }
  storage.setItem(`wolkenworte-basket-label:${first}`,'Our cloud');
  storage.setItem('wolkenworte-order:../unsafe',JSON.stringify([{id:'x'.repeat(16)}]));
  const baskets=Baskets.list(storage);
  assert.deepEqual(baskets.map(basket=>basket.slug),[first,second]);
  assert.equal(baskets[0].count,1);
  Baskets.mount(dom.window.document,storage);
  assert.deepEqual([...dom.window.document.querySelectorAll('a')].map(link=>link.getAttribute('href')),
    [`/e/${first}/configure?cart=1`,`/e/${second}/configure?cart=1`]);
  assert.match(dom.window.document.body.textContent,/Our cloud/);
});

test('basket groups expose a heading, meaningful fallback names and singular/plural counts in every locale',t=>{
  const {translate}=require('../src/i18n');
  const original=globalThis.WolkenworteI18n;
  t.after(()=>{globalThis.WolkenworteI18n=original;});
  for(const locale of ['de','en','fr','it','es','tr']){
    const dom=new JSDOM('<section data-browser-baskets></section>',{url:'https://wolkenworte.test/'});
    t.after(()=>dom.window.close());
    const storage=dom.window.localStorage;
    storage.setItem(`wolkenworte-order:${'a'.repeat(22)}`,JSON.stringify([{id:'x'.repeat(16)}]));
    storage.setItem(`wolkenworte-order:${'b'.repeat(22)}`,JSON.stringify([{id:'y'.repeat(16)},{id:'z'.repeat(16)}]));
    storage.setItem(`wolkenworte-basket-label:${'b'.repeat(22)}`,'USA 2026');
    globalThis.WolkenworteI18n={setText:(element,source,params)=>{element.textContent=translate(source,locale,params);}};
    Baskets.mount(dom.window.document,storage);
    const host=dom.window.document.querySelector('[data-browser-baskets]'),links=[...host.querySelectorAll('a')];
    assert.equal(host.querySelector('h2').textContent,translate('Warenkörbe in diesem Browser',locale));
    assert.equal(host.querySelector('h2 a, h2 button'),null,'the heading is not an action');
    assert.equal(links[0].querySelector('.ww-basket-name').textContent,translate('Warenkorb {{number}}',locale,{number:1}));
    assert.equal(links[0].querySelector('.ww-basket-count').textContent,translate('{{count}} Design',locale,{count:1}));
    assert.equal(links[1].querySelector('.ww-basket-count').textContent,translate('{{count}} Designs',locale,{count:2}));
    assert.equal(links[1].querySelector('.ww-basket-name').textContent,'USA 2026');
  }
});
