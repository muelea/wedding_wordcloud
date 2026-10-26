'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {createCanvas, loadImage} = require('canvas');
const THREE = require('three');
const {PRODUCTS, getProduct} = require('../src/products');
const {catalogPrice} = require('../src/pricing');
const {isPrintDesignWithinBounds} = require('../src/mugPrint');
const {renderProviderPng} = require('../src/printRaster');
const Geometry = require('../public/js/product-3d-geometry');
const manifest = require('../src/productCatalogManifest.json');
const audit = require('./fixtures/phone-case-catalog.json');
const cases = PRODUCTS.filter(p => p.previewModel?.kind === 'case');
const unique = cases.filter((p,i) => cases.findIndex(q => q.printful.productId === p.printful.productId && q.previewModel.device === p.previewModel.device) === i);
const root = path.join(__dirname,'..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function inside(x,y,polygon) {
  let result = false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
    const [xi,yi]=polygon[i], [xj,yj]=polygon[j];
    if((yi>y)!==(yj>y) && x<(xj-xi)*(y-yi)/(yj-yi)+xi) result=!result;
  }
  return result;
}

test('all 140 active Germany/EU tough cases retain exact provider models, finishes, template identities and prices', () => {
  assert.equal(cases.length,140);
  assert.equal(unique.length,70);
  for(const [id,count,models] of [[601,58,29],[798,36,18],[686,46,23]]) {
    const offered=cases.filter(p=>p.printful.productId===id), family=audit.families.find(f=>f.productId===id);
    assert.equal(offered.length,count);
    assert.equal(new Set(offered.map(p=>p.previewModel.device)).size,models);
    assert.deepEqual(offered.map(p=>p.printful.variantId).sort((a,b)=>a-b),family.variants.map(v=>v.variantId).sort((a,b)=>a-b));
    for(const source of family.variants) {
      const product=offered.find(p=>p.printful.variantId===source.variantId);
      const record=manifest.products.find(r=>r.key===product.key);
      assert.equal(product.previewModel.device,source.model);
      assert.equal(product.previewModel.finish,source.finish.toLowerCase());
      assert.equal(source.departureCountry,'IT');
      assert.equal(product.printful.technique,'sublimation');
      assert.deepEqual(product.printful.placements,['default']);
      assert.equal(product.printFile.dpi,300);
      assert.equal(product.orientationOptions.length,0);
      assert.ok(record.templates.some(t=>t.role==='template' && t.catalog_variant_ids.includes(source.variantId) && t.printfile_id===product.printful.printfileId),product.key);
      assert.ok(catalogPrice(source.variantId).unitGrossCents>0);
      const pair=offered.filter(p=>p.previewModel.device===source.model);
      assert.equal(pair.length,2);
      assert.equal(offered.indexOf(pair[1])-offered.indexOf(pair[0]),1,
        source.model+': finishes remain adjacent in the variant selector');
      assert.deepEqual(pair[0].printFile,pair[1].printFile);
      assert.deepEqual(pair[0].designSafeAreas,pair[1].designSafeAreas);
      assert.deepEqual(pair[0].previewModel.cameraPath,pair[1].previewModel.cameraPath);
    }
  }
});

test('device camera contours and safe rectangles stay inside their hash-pinned provider guides', async () => {
  for(const product of unique) {
    const record=manifest.products.find(r=>r.key===product.key), guide=record.guide;
    const bytes=fs.readFileSync(path.join(root,guide.localFixture));
    assert.equal(hash(bytes),guide.sha256,product.key);
    const image=await loadImage(bytes), canvas=createCanvas(image.width,image.height), ctx=canvas.getContext('2d');
    ctx.drawImage(image,0,0);
    const rgba=ctx.getImageData(0,0,image.width,image.height).data;
    const t=record.templates.find(t=>t.role==='template'), m=product.previewModel, safe=product.designSafeAreas.default;
    const px=fileX=>(t.print_area_left+fileX/product.printFile.width*t.print_area_width)*image.width/t.template_width;
    const py=fileY=>(t.print_area_top+fileY/product.printFile.height*t.print_area_height)*image.height/t.template_height;
    for(const [x,y] of m.cameraPath) {
      const gx=px((m.face.x+(x/m.width+.5)*m.face.width)*product.printFile.width);
      const gy=py((m.face.y+(.5-y/m.height)*m.face.height)*product.printFile.height);
      let found=false;
      for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
        const i=(Math.round(gy+dy)*image.width+Math.round(gx+dx))*4;
        if(rgba[i]>=148&&rgba[i]<=160&&rgba[i]===rgba[i+1]&&rgba[i+3]>230)found=true;
      }
      assert.ok(found,product.key+': contour comes from the exact guide');
    }
    // Check the full rectangle, including its corners, against the original
    // mask. MagSafe's faint relief lines are printable, unlike camera/bleed.
    for(let y=Math.ceil(py(safe.y));y<=Math.floor(py(safe.y+safe.height));y+=3)for(let x=Math.ceil(px(safe.x));x<=Math.floor(px(safe.x+safe.width));x+=3){
      const i=(y*image.width+x)*4, alpha=rgba[i+3];
      const ring=product.previewModel.magSafe&&alpha<200&&rgba[i]>=120&&rgba[i]<=215;
      let edge=false;
      // The earlier audited rectangles can touch a resized dotted guide stroke.
      // Allow its two-pixel sampling uncertainty, never a solid camera/bleed.
      for(let dy=-2;dy<=2&&!edge;dy++)for(let dx=-2;dx<=2;dx++)if(rgba[((y+dy)*image.width+x+dx)*4+3]<3)edge=true;
      assert.ok(alpha<5||ring||edge,`${product.key}: safe rectangle enters a masked pixel at ${x},${y}`);
    }
    canvas.width=1;
  }
});

test('each device renders its actual camera arrangement, including single/dual cameras and the S20 Ultra periscope', () => {
  for(const product of unique) {
    const m=product.previewModel, d=m.cameraDetails, c=m.camera;
    const expected=product.printful.productId===686 ? /S20 Ultra/.test(m.device)?3:/Ultra/.test(m.device)?4:3
      : /Air/.test(m.device)?1:/Pro/.test(m.device)?3:2;
    assert.equal(d.lenses.length,expected,m.device);
    for(const [u,v,r] of [...d.lenses,...d.sensors,[...d.flash]])for(let k=0;k<12;k++){
      const angle=k/12*Math.PI*2;
      assert.ok(inside(c.x+c.width*u+Math.cos(angle)*r*Math.min(c.width,c.height),
        c.y+c.height*v+Math.sin(angle)*r*Math.min(c.width,c.height),m.cameraPath),m.device+': camera accessory stays in its opening');
    }
    const group=new THREE.Group(), texture=new THREE.Texture();
    Geometry.build(THREE,group,texture,product,new THREE.Texture());
    const lenses=[]; group.traverse(mesh=>{if(mesh.name==='display-phone-lens')lenses.push(mesh);});
    assert.equal(lenses.length,expected,m.device);
    assert.equal(group.getObjectByName('case-printed-shell').geometry.parameters.shapes.holes.length,1);
    if(/S20 Ultra/.test(m.device))assert.ok(lenses.some(mesh=>mesh.geometry.type==='PlaneGeometry'));
    for(const [index,lens] of lenses.entries()) {
      assert.ok(Math.abs(lens.position.x-(c.x+c.width*d.lenses[index][0]))<1e-9);
      assert.ok(Math.abs(lens.position.y-(c.y+c.height*d.lenses[index][1]))<1e-9);
    }
    group.traverse(mesh=>{mesh.geometry?.dispose(); for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material])material?.dispose();});
    texture.dispose();
  }
});

test('all iPhone 17 MagSafe photos use the corresponding unmodified gallery image, preserving transparency', async () => {
  const hashes=new Set();
  for(const [device,source] of Object.entries(audit.galleryOverrides)) {
    const pair=manifest.products.filter(r=>r.productId===798&&r.label===device);
    assert.equal(pair.length,2);
    assert.equal(pair[0].productPhoto,pair[1].productPhoto);
    for(const record of pair) {
      assert.equal(record.providerImage,source.url);
      assert.equal(record.photoSource.imageId,source.id);
      const bytes=fs.readFileSync(path.join(root,'public',record.productPhoto));
      assert.equal(hash(bytes),record.photoSha256);
      hashes.add(record.photoSha256);
      const image=await loadImage(bytes), ctx=createCanvas(1,1).getContext('2d');
      ctx.drawImage(image,0,0);
      assert.ok(ctx.getImageData(0,0,1,1).data[3]<=8,device+': original transparent background');
    }
  }
  assert.equal(hashes.size,4,'four different device photos');
});

test('each phone model exports corner landmarks at exact provider pixels and rejects the camera region', async () => {
  const marker=createCanvas(16,16), brush=marker.getContext('2d');
  brush.fillStyle='#0066ff'; brush.fillRect(0,0,16,16);
  const src=marker.toDataURL();
  for(const product of unique) {
    const a=product.designSafeAreas.default;
    const points=[[a.x+20,a.y+20],[a.x+a.width-20,a.y+20],[a.x+20,a.y+a.height-20],[a.x+a.width-20,a.y+a.height-20]];
    const design=points.map(([x,y],i)=>({id:'corner-'+i,type:'image',src,x,y,width:16,height:16,angle:0}));
    assert.ok(isPrintDesignWithinBounds(design,product.printFile.width,product.printFile.height,a));
    const cameraRegion=[{...design[0],x:a.x+a.width/2,y:a.y-30}];
    assert.equal(isPrintDesignWithinBounds(cameraRegion,product.printFile.width,product.printFile.height,a),false);
    const image=await loadImage(await renderProviderPng(product,design));
    assert.equal(image.width,product.printFile.width); assert.equal(image.height,product.printFile.height);
    const ctx=createCanvas(1,1).getContext('2d');
    for(const [x,y] of points){ctx.clearRect(0,0,1,1);ctx.drawImage(image,-x,-y);assert.deepEqual([...ctx.getImageData(0,0,1,1).data],[0,102,255,255],product.key);}
    ctx.clearRect(0,0,1,1);ctx.drawImage(image,-cameraRegion[0].x,-cameraRegion[0].y);
    assert.equal(ctx.getImageData(0,0,1,1).data[3],0);
  }
});
