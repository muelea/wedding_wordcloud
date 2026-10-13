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
