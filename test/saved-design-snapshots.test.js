'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createCanvas}=require('canvas');
const {getProduct,resolveProductOrientation}=require('../src/products');
const {productDesignPayload}=require('./helpers');
const designs=require('../src/savedDesigns');
test('blanket library snapshots retain each orientation and legacy horizontal arrangements through encoding', () => {
  for (const key of ['throw-blanket-50x60in', 'throw-blanket-30x40in']) for (const orientation of ['default', 'portrait', 'landscape']) {
    const payload = { productKey: key, orientation, theme: 'pastel', words: [['Liebe', 1]], ...productDesignPayload(key, orientation) };
    const snapshot = designs.normalizeSnapshot(payload);
    assert.equal(snapshot.orientation, orientation);
    assert.deepEqual(designs.decodeSnapshot(designs.encodeSnapshot(snapshot)), snapshot);
  }
});
test('editable snapshots retain both faces, images, text styles and hidden product arrangements with deduplicated pixels',()=>{
  const product=resolveProductOrientation(getProduct('all-over-basic-pillow-18in'),'default');
  const canvas=createCanvas(20,20);canvas.getContext('2d').fillRect(0,0,20,20);const src=canvas.toDataURL();
  const payload={productKey:product.key,orientation:'default',theme:'pastel',words:[['Liebe',1]],...productDesignPayload(product.key)};
  for(const surface of product.printSurfaces){
    const area=product.designSafeAreas[surface.key];const text=payload.designs[surface.key][0];
    Object.assign(text,{fontWeight:700,fontStyle:'italic',underline:true,linethrough:true,colorLocked:true});
    payload.designs[surface.key].push({id:'image-'+surface.key,type:'image',src,width:100,height:100,x:area.x+area.width/2,y:area.y+area.height/2,angle:0});
  }
  payload.productDesignState={version:1,surfaces:product.printSurfaces.map(surface=>({area:product.designSafeAreas[surface.key],design:payload.designs[surface.key]})),
    layouts:[{productKey:product.key,orientation:'default',surfaces:product.printSurfaces.map(surface=>payload.designs[surface.key].map(({id,type,x,y,fontSize,width,height,angle})=>({id,type:type||'text',x,y,fontSize,width,height,angle})))}]};
  const normalized=designs.normalizeSnapshot(payload,'en'),encoded=designs.encodeSnapshot(normalized),packet=JSON.parse(encoded);
  assert.equal(packet.images.length,1);assert.deepEqual(designs.decodeSnapshot(encoded),normalized);
  assert.equal(Object.keys(normalized.designs).length,2);assert.equal(normalized.productDesignState.layouts.length,1);
  for(const surface of product.printSurfaces)assert.equal(normalized.designs[surface.key][0].colorLocked,true);
  assert.ok(normalized.customColors.length,'an empty palette restores safely with the product default');
  const unsafe=structuredClone(payload);unsafe.designs[product.printSurfaces[0].key][1].src='https://attacker.example/image.png';
  assert.throws(()=>designs.normalizeSnapshot(unsafe),/invalid_design/);
  assert.throws(()=>designs.designName('x'.repeat(81)),/invalid_design_name/);
});

test('account snapshots preserve long personal text through normalization, encoding and decoding', () => {
  const product = getProduct('white-glossy-mug-duo-11oz');
  const text = 'Unsere Erinnerungen bleiben für immer. '.repeat(35).trim();
  assert.ok(text.length > 1024);
  const payload = { productKey: product.key, orientation: 'default', theme: 'pastel', words: [],
    ...productDesignPayload(product.key) };
  for (const surface of product.printSurfaces) {
    Object.assign(payload.designs[surface.key][0], { text, fontSize: 2 });
  }
  const snapshot = designs.normalizeSnapshot(payload);
  const decoded = designs.decodeSnapshot(designs.encodeSnapshot(snapshot));
  for (const surface of product.printSurfaces) assert.equal(decoded.designs[surface.key][0].text, text);
});
