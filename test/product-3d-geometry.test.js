'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const THREE = require('three');
const Geometry = require('../public/js/product-3d-geometry');
const { PRODUCTS, getProduct, resolveProductOrientation } = require('../src/products');
const manifest = require('../src/productCatalogManifest.json');

function model(product) {
  const group = new THREE.Group();
  Geometry.build(THREE, group, new THREE.Texture(), product, new THREE.Texture());
  group.updateMatrixWorld(true);
  return group;
}
function ray(group, x, y) {
  return new THREE.Raycaster(new THREE.Vector3(x,y,30), new THREE.Vector3(0,0,-1)).intersectObjects(group.children, true);
}
function inside([x,y], polygon) {
  let result = false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
    const [xi,yi]=polygon[i], [xj,yj]=polygon[j];
    if ((yi>y)!==(yj>y) && x<(xj-xi)*(y-yi)/(yj-yi)+xi) result=!result;
  }
  return result;
}

test('travel mug artwork stays in the upper printable cylinder shown by the provider guides and calibration mockups', () => {
  for (const key of ['travel-mug-16440', 'travel-mug-19514']) {
    const product = getProduct(key), profile = product.previewModel;
    const height = product.printFile.height / product.printFile.dpi * 2.54;
    const top = profile.printCenterY + height / 2;
    const bottom = profile.printCenterY - height / 2;
    const rimGap = product.size.heightCm / 2 - top;
    assert.ok(rimGap >= .5 && rimGap <= .8, `${key}: print band begins just below the rim`);
    const safe = product.designSafeAreas.default;
    const lowestText = top - (safe.y + safe.height) / product.printFile.dpi * 2.54;
    const cylinderStart = profile.profile.at(-2)[1];
    assert.ok(lowestText > cylinderStart, `${key}: text must stay above the cup-holder taper`);
    assert.ok(bottom >= cylinderStart - .4);
    // Regression: these are the same provider files; preview calibration must
    // never move or resize the immutable artwork that is uploaded for print.
    const source = require('./fixtures/printful-geometry.json').products.find(p => p.productKey === key);
    assert.equal(product.printFile.width, source.printfile.width);
    assert.equal(product.printFile.height, source.printfile.height);
  }
});

test('travel mug handles match the white body and attach above the taper near the rim', () => {
  for (const key of ['travel-mug-16440', 'travel-mug-19514']) {
    const product = getProduct(key), group = model(product), height = product.size.heightCm;
    const handle = group.children.find(mesh => mesh.geometry.type === 'TubeGeometry');
    assert.ok(handle, key);
    assert.equal(handle.material.color.getHexString(), 'ffffff', key);
    const path = handle.geometry.parameters.path;
    const upper = path.getPoint(0), lower = path.getPoint(1);
    assert.ok(upper.y > height * .35 && upper.y < height * .43, `${key}: upper attachment sits close to the rim`);
    const bounds = new THREE.Box3().setFromObject(handle);
    const cylinderStart = product.previewModel.profile.at(-2)[1];
    assert.ok(bounds.min.y > cylinderStart, `${key}: entire handle stays above the taper`);
    assert.ok(upper.y - lower.y > height * .3, `${key}: handle retains a usable opening`);
    assert.ok(handle.geometry.parameters.radius <= .28, `${key}: handle matches the slim reference profile`);
  }
});

test('only the larger travel mug has a straw, with a short exposed section that reduces preview bounds', () => {
  const strawFor = group => group.children.find(mesh => mesh.geometry.type === 'CylinderGeometry' &&
    mesh.geometry.parameters.radiusTop < .2);
  assert.equal(strawFor(model(getProduct('travel-mug-16440'))), undefined);
  const product = getProduct('travel-mug-19514'), group = model(product), straw = strawFor(group);
  assert.ok(straw);
  const rim = product.size.heightCm / 2;
  const bounds = new THREE.Box3().setFromObject(straw);
  const exposed = bounds.max.y - rim;
  assert.ok(exposed > 3.5 && exposed < 4.5, 'exposed straw matches the reference proportions');
  assert.ok(bounds.min.y < rim, 'straw remains inserted into the lid');
  const radius = object => {
    let result = 0;
    object.traverse(mesh => {
      const positions = mesh.geometry?.getAttribute('position');
      for (let i = 0; i < (positions?.count || 0); i++) result = Math.max(result,
        new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld).length());
    });
    return result;
  };
  const shorterRadius = radius(group);
  straw.geometry.dispose();
  straw.geometry = new THREE.CylinderGeometry(.16, .16, 7, 24);
  straw.position.y = rim + 3.2;
  group.updateMatrixWorld(true);
  assert.ok(shorterRadius < radius(group) * .9, 'shorter straw lets existing gallery framing enlarge the mug');
});

test('case openings are real holes and the safe-area centre maps to the exact provider pixel', () => {
  // Finish pairs share a device mesh and UVs (checked by the catalog test).
  for(const product of PRODUCTS.filter(p=>p.previewModel?.kind==='case' && p.previewModel.finish==='matte')) {
    const profile=product.previewModel, group=model({ ...product, previewModel: { ...profile, displayPhone: false } }), safe=product.designSafeAreas.default;
    const u=(safe.x+safe.width/2)/product.printFile.width;
    const v=1-(safe.y+safe.height/2)/product.printFile.height;
    const x=((u-profile.face.x)/profile.face.width-.5)*profile.width;
    const y=((v-(1-profile.face.y-profile.face.height))/profile.face.height-.5)*profile.height;
    const hit=ray(group,x,y)[0];
    assert.ok(hit,product.key);
    assert.ok(Math.abs(hit.uv.x-u)<1e-6 && Math.abs(hit.uv.y-v)<1e-6,product.key);
    const polygon=profile.cameraPath;
    const samples=[];
    for(let x=-profile.width/2+.2;x<profile.width/2;x+=.4)for(let y=1;y<profile.height/2-.2;y+=.4) {
      if(!inside([x,y],polygon))continue;
      const edgeDistance = Math.min(...polygon.map(([ax,ay],i) => {
        const [bx,by]=polygon[(i+1)%polygon.length], dx=bx-ax, dy=by-ay;
        const t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy||1)));
        return Math.hypot(x-ax-t*dx,y-ay-t*dy);
      }));
      if(edgeDistance<.12)continue; // the physical bevel remains around the opening
      samples.push([x,y]);
    }
    assert.ok(samples.length>5);
    for(let i=0;i<Math.min(samples.length,16);i++) {
      const [x,y]=samples[Math.floor(i*(samples.length-1)/Math.max(1,Math.min(samples.length,16)-1))];
      assert.equal(ray(group,x,y).length,0,`${product.key}: camera opening must remain empty`);
    }
    group.traverse(mesh=>{mesh.geometry?.dispose();(Array.isArray(mesh.material)?mesh.material:[mesh.material]).forEach(m=>m?.dispose());});
  }
});

test('black framed posters share the oak frame geometry and full print UVs in both orientations', () => {
  for (const product of PRODUCTS.filter(p => p.previewShape === 'framed-poster')) {
    assert.equal(product.previewType, '3d', product.key);
    assert.equal(product.previewModel.kind, 'panel', product.key);
    assert.equal(product.previewMesh, null, `${product.key}: frames use custom geometry`);
  }
  for (const orientation of ['portrait', 'landscape']) {
    const black = resolveProductOrientation(getProduct('framed-matte-poster-black-30x40cm'), orientation);
    const oak = resolveProductOrientation(getProduct('framed-poster-11791'), orientation);
    const blackGroup = model(black), oakGroup = model(oak);
    assert.equal(blackGroup.children.length, oakGroup.children.length);
    blackGroup.children.forEach((mesh, index) => {
      const reference = oakGroup.children[index];
      assert.equal(mesh.geometry.type, reference.geometry.type);
      assert.deepEqual(mesh.geometry.getAttribute('position').array, reference.geometry.getAttribute('position').array);
      assert.deepEqual(mesh.geometry.getAttribute('uv').array, reference.geometry.getAttribute('uv').array);
      assert.deepEqual(mesh.position.toArray(), reference.position.toArray());
    });
    const rails = blackGroup.children.filter(mesh => mesh.geometry.type === 'BoxGeometry');
    assert.equal(rails.length, 4);
    assert.ok(rails.every(mesh => mesh.material.color.getHexString() === '202124'));
    const { width, height } = black.previewModel;
    const hit = ray(blackGroup, width * .25, height * .25)[0];
    assert.ok(Math.abs(hit.uv.x - .75) < 1e-6 && Math.abs(hit.uv.y - .75) < 1e-6,
      `${orientation}: full artwork retains its normalized print coordinates`);
    assert.ok(fs.existsSync(require('node:path').join(__dirname, '../public', black.previewMockup.assets.default)),
      'the existing reference photograph remains available');
  }
});

test('canvas artwork reserves the fold and keeps front UVs correct in both orientations', () => {
  for(const orientation of ['portrait','landscape']) {
    const product=resolveProductOrientation(getProduct('canvas-12x16in'),orientation);
    const group=model(product), {width,height,face}=product.previewModel;
    assert.ok(Math.abs(ray(group,0,0)[0].uv.x-.5)<1e-6);
    assert.ok(Math.abs(ray(group,width*.4,height*.4)[0].uv.x-(face.x+.9*face.width))<1e-6);
    const safe=product.designSafeAreas.default;
    assert.ok(safe.x>900&&safe.y>900);
  }
});

test('expanded canvases map their exact front crop, keep unprinted backs and model the floating frame independently', () => {
  for (const source of PRODUCTS.filter(p => p.previewModel?.style && p.previewModel.kind === 'canvas')) {
    for (const orientation of source.orientationOptions.length ? ['portrait', 'landscape'] : ['default']) {
      const product = resolveProductOrientation(source, orientation), group = model(product), m = product.previewModel;
      const hit = ray(group, m.width * .25, m.height * .25)[0];
      assert.equal(hit.object.name, 'canvas-cloth');
      assert.ok(Math.abs(hit.uv.x - (m.face.x + .75 * m.face.width)) < 1e-6, `${source.key}/${orientation}`);
      assert.ok(Math.abs(hit.uv.y - (1 - m.face.y - .25 * m.face.height)) < 1e-6);
      const rear = new THREE.Raycaster(new THREE.Vector3(m.width * .2, m.height * .2, -30), new THREE.Vector3(0, 0, 1)).intersectObjects(group.children, true)[0];
      const material = Array.isArray(rear.object.material) ? rear.object.material[rear.face.materialIndex] : rear.object.material;
      assert.equal(material.map, null, `${source.key}: reverse never shows the front print`);
      assert.ok(group.getObjectByName('canvas-hanger'));
      assert.equal(group.children.filter(mesh => mesh.name === 'canvas-stretcher').length, 4);
      const frame = group.getObjectByName('canvas-floating-frame');
      assert.equal(Boolean(frame), m.style === 'framed');
      if (frame) {
        assert.equal(frame.material.color.getHexString(), m.frameColor.slice(1));
        const gap = ray(group, m.width / 2 + .35, 0)[0];
        assert.equal(gap.object.name, 'canvas-frame-backing', 'floating gap remains visibly recessed');
        assert.ok(gap.point.z < hit.point.z - .5);
      }
      group.traverse(mesh => {
        mesh.geometry?.dispose();
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material?.dispose();
      });
    }
  }
});

test('new variants retain independent provider identities, source evidence and local reference photos', () => {
  const ids = new Set();
  for(const record of manifest.products) {
    const product=getProduct(record.key);
    assert.ok(!ids.has(product.printful.variantId));ids.add(product.printful.variantId);
    assert.ok(record.templates.length>0,record.key);
    const photo = fs.readFileSync(require('node:path').join(__dirname,'../public',product.productPhoto));
    assert.equal(require('node:crypto').createHash('sha256').update(photo).digest('hex'), record.photoSha256);
    if(product.printful.productId===367)assert.deepEqual(product.printful.placements,['front']);
  }
  const source=fs.readFileSync(require.resolve('../views/configure.ejs'),'utf8');
  assert.ok(source.indexOf("asset('/js/product-3d-geometry.js')")<source.indexOf("asset('/js/mug-3d-viewer.js')"));
});

test('pillow and tote reverse faces keep the artwork readable when rotated', () => {
  for(const key of ['all-over-basic-pillow-49853','all-over-basic-pillow-9513','all-over-tote-8904']) {
    const product=getProduct(key), group=model(product), width=product.previewModel.width;
    const front=new THREE.Raycaster(new THREE.Vector3(width*.2,0,30),new THREE.Vector3(0,0,-1)).intersectObjects(group.children,true)[0];
    const back=new THREE.Raycaster(new THREE.Vector3(-width*.2,0,-30),new THREE.Vector3(0,0,1)).intersectObjects(group.children,true)[0];
    assert.ok(front && back,key);
    assert.ok(front.uv.x>.5 && back.uv.x>.5,`${key}: camera-right must mean artwork-right on each face`);
    assert.ok(Math.abs(front.uv.x-back.uv.x)<1e-6,key);
  }
});

test('all five bags have separate cloth faces, volumetric sides, boxed bases and two woven handles', () => {
  const bags = PRODUCTS.filter(p => p.familyKey === 'bags');
  assert.equal(bags.length, 5);
  for (const product of bags) {
    assert.equal(product.previewType, '3d', product.key);
    const group = model(product), m = product.previewModel;
    const front = group.getObjectByName('bag-front'), back = group.getObjectByName('bag-back');
    const bounds = new THREE.Box3().setFromObject(group);
    assert.ok(bounds.getSize(new THREE.Vector3()).z > m.depth * .8, `${product.key}: retains volume side-on`);
    assert.ok(front && back && group.getObjectByName('bag-base'));
    assert.equal(group.children.filter(mesh => mesh.name.startsWith('bag-side-')).length, 4);
    const handles = group.children.filter(mesh => mesh.name.startsWith('bag-handle-'));
    assert.equal(handles.length, 2);
    for (const handle of handles) {
      const positions = handle.geometry.getAttribute('position');
      const a = new THREE.Vector3().fromBufferAttribute(positions, 0), b = new THREE.Vector3().fromBufferAttribute(positions, 1);
      assert.ok(Math.abs(a.distanceTo(b) - 2.5) < 1e-5, '2.5 cm webbing, including around the top bend');
      assert.ok(handle.material.bumpMap && handle.material.roughness > .9);
      assert.equal(handle.material.color.getHexString(), m.handleColor.slice(1));
    }
    const frontBounds = new THREE.Box3().setFromObject(front), backBounds = new THREE.Box3().setFromObject(back);
    assert.ok(frontBounds.min.z > 0 && backBounds.max.z < 0, 'front and back are separated cloth walls');
    // Start below the handles and look down through the open compartment.
    const top = m.height / 2 + front.position.y;
    const hit = new THREE.Raycaster(new THREE.Vector3(0, top + 2, 0), new THREE.Vector3(0, -1, 0))
      .intersectObjects(group.children.filter(mesh => mesh.isMesh), true)[0];
    assert.equal(hit.object.name, 'bag-base', 'the mouth is open, rather than capped by a solid box');
    assert.ok(hit.point.y < top - m.height * .9);
    const size = bounds.getSize(new THREE.Vector3());
    assert.ok(Math.abs(bounds.getCenter(new THREE.Vector3()).y) < 1, 'centred geometry fills the existing camera framing');
    assert.ok(size.y > m.height + 18 && size.y < m.height + 24);
  }
});

test('organic cotton artwork uses the full 25.4 cm front file and never appears on the back or straps', () => {
  for (const key of ['eco-tote-10458', 'eco-tote-10457']) {
    const product = getProduct(key), group = model(product), m = product.previewModel;
    const patch = group.getObjectByName('bag-front-print'), back = group.getObjectByName('bag-back');
    assert.equal(m.width, 40.6); assert.equal(m.height, 35.6); assert.equal(m.depth, 12.7);
    assert.deepEqual(product.printful.placements, ['front']);
    assert.equal(back.material.map, null);
    assert.equal(back.material.color.getHexString(), product.previewMockup.backgroundColor.slice(1));
    const mapped = group.children.filter(mesh => mesh.material?.map === patch.material.map);
    assert.deepEqual(mapped.map(mesh => mesh.name), ['bag-front-print']);
    const uv = patch.geometry.getAttribute('uv'), positions = patch.geometry.getAttribute('position');
    assert.equal(uv.getX(0), 0); assert.equal(uv.getY(0), 0);
    assert.equal(uv.getX(uv.count - 1), 1); assert.equal(uv.getY(uv.count - 1), 1);
    const index = 48 * 65 + 48;
    const point = new THREE.Vector3().fromBufferAttribute(positions, index).add(patch.position);
    const hit = ray(group, point.x, point.y).find(hit => hit.object === patch);
    assert.ok(Math.abs(hit.uv.x - .75) < 1e-5 && Math.abs(hit.uv.y - .75) < 1e-5);
    assert.ok(Math.abs(positions.getX(64) - positions.getX(0)) <= 25.4 + 1e-5);
    assert.equal(product.printFile.width, 1500); assert.equal(product.printFile.height, 1500);
    assert.equal(product.printFile.dpi, 150);
    assert.deepEqual(product.designSafeAreas.front, { x: 75, y: 75, width: 1350, height: 1350 });
  }
});

test('bag weave textures are released once with the existing material lifecycle', () => {
  const group = model(getProduct('all-over-tote-8904'));
  const weave = group.getObjectByName('bag-front').material.bumpMap;
  let releases = 0; weave.addEventListener('dispose', () => releases++);
  group.traverse(mesh => mesh.material?.dispose());
  assert.equal(releases, 1);
});

test('all matte poster sizes use thin 3D paper with a blank light back and full print UVs', () => {
  for (const product of PRODUCTS.filter(p => p.previewShape === 'poster')) for (const orientation of ['portrait', 'landscape']) {
    const oriented = resolveProductOrientation(product, orientation), group = model(oriented), m = oriented.previewModel;
    assert.equal(oriented.previewType, '3d');
    assert.equal(m.depth, .03);
    assert.ok(Math.abs(m.width / m.height - oriented.printFile.width / oriented.printFile.height) < 1e-6);
    const hit = ray(group, m.width * .25, m.height * .25)[0];
    assert.ok(Math.abs(hit.uv.x - .75) < 1e-6 && Math.abs(hit.uv.y - .75) < 1e-6);
    const back = new THREE.Raycaster(new THREE.Vector3(0, 0, -30), new THREE.Vector3(0, 0, 1)).intersectObjects(group.children, true)[0];
    const surface = Array.isArray(back.object.material) ? back.object.material[back.face.materialIndex] : back.object.material;
    assert.equal(surface.map, null);
    assert.ok(surface.color.r > .8 && surface.color.g > .8 && surface.color.b > .8);
  }
});

test('poster backs own their opaque cap material and never hide a printed cap under a covering plane', () => {
  for (const product of PRODUCTS.filter(p => p.previewModel?.kind === 'panel')) {
    const group = model(product), caps = group.children.filter(mesh => mesh.geometry.type === 'ExtrudeGeometry');
    assert.equal(caps.length, 1);
    assert.equal(group.children.filter(mesh => mesh.geometry.type === 'PlaneGeometry').length, 0);
    const mesh = caps[0], geometry = mesh.geometry, normals = geometry.attributes.normal;
    let rearTriangles = 0, frontTriangles = 0;
    for (const section of geometry.groups) for (let i = section.start; i < section.start + section.count; i += 3) {
      const surface = mesh.material[section.materialIndex];
      if (normals.getZ(i) < -.99) {
        rearTriangles++; assert.equal(surface.map, null, `${product.key}: no hidden rear artwork`);
        assert.equal(surface.transparent, false); assert.equal(surface.opacity, 1);
      }
      if (normals.getZ(i) > .99) { frontTriangles++; assert.ok(surface.map, product.key); }
    }
    assert.ok(rearTriangles > 0 && frontTriangles > 0);
  }
});

test('both sleeves have padded opaque skins, textured binding and two full zipper pulls', () => {
  for (const product of PRODUCTS.filter(p => p.previewModel?.kind === 'sleeve')) {
    const group = model(product), m = product.previewModel;
    const front = group.getObjectByName('sleeve-front'), back = group.getObjectByName('sleeve-back');
    const p = front.geometry.attributes.position;
    const centre = p.getZ(36 * 97 + 48), edge = p.getZ(36 * 97);
    assert.ok(centre > m.depth * .45 && edge < .1, 'neoprene loft tapers into its binding');
    assert.ok(front.material[0].map && front.material[0].bumpMap);
    assert.equal(back.material.map, null); assert.equal(back.material.transparent, false);
    assert.ok(back.material.color.getHexString() === '191b1e');
    const tabs = group.children.filter(mesh => mesh.name.startsWith('sleeve-zipper-pull-'));
    assert.equal(tabs.length, 2);
    assert.ok(tabs.every(mesh => mesh.geometry.parameters.shapes.holes.length === 1));
    assert.ok(group.getObjectByName('sleeve-padded-binding'));
    const reverse = new THREE.Raycaster(new THREE.Vector3(0, 0, -10), new THREE.Vector3(0, 0, 1)).intersectObjects(group.children, true)[0];
    assert.equal(reverse.object, back);
    let releases = 0; front.material[0].bumpMap.addEventListener('dispose', () => releases++);
    group.traverse(mesh => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).filter(Boolean).forEach(m => m.dispose()));
    assert.equal(releases, 1);
  }
});

test('case shells have hollow interiors, open charging ports and independent display handsets', () => {
  for (const product of PRODUCTS.filter(p => p.previewModel?.kind === 'case')) {
    const bare = model({ ...product, previewModel: { ...product.previewModel, displayPhone: false } });
    const { width, height, depth, face } = product.previewModel;
    const shell = bare.getObjectByName('case-printed-shell');
    assert.equal(bare.getObjectByName('case-front-lip').position.z,-depth/2,
      product.key + ': the Air uses its own shallower case depth');
    assert.ok(bare.getObjectByName('case-outer-wall') && bare.getObjectByName('case-inner-wall'));
    const interior = new THREE.Raycaster(new THREE.Vector3(0, 0, -2), new THREE.Vector3(0, 0, 1)).intersectObjects(bare.children, true)[0];
    assert.equal(interior.object.uuid, shell.uuid, product.key + ': interior ray reaches the rear plate');
    assert.ok(interior.point.z > depth / 2 - .22, 'air cavity reaches the back plate');
    assert.equal(shell.material[interior.face.materialIndex].map, null, 'liner has no rear print to shine through');
    const port = new THREE.Raycaster(new THREE.Vector3(0, -height / 2 - 1, -.16), new THREE.Vector3(0, 1, 0))
      .intersectObjects(bare.children, true)[0];
    assert.ok(!port || port.point.y > 0, 'charging opening passes through the lower wall');
    const wall = bare.getObjectByName('case-outer-wall'), p = wall.geometry.attributes.position, uv = wall.geometry.attributes.uv;
    let wrapped = false;
    for (let i = 0; i < p.count; i++) if (Math.abs(p.getX(i)) > width / 2 - .02 && p.getZ(i) < 0) {
      const flatU = face.x + (p.getX(i) / width + .5) * face.width;
      if (Math.abs(flatU - uv.getX(i)) > .02) wrapped = true;
      assert.ok(uv.getX(i) >= 0 && uv.getX(i) <= 1);
    }
    assert.ok(wrapped, 'exterior sides continue the print into its reserved wrap bleed');
    const dressed = model(product), phone = dressed.getObjectByName('display-phone');
    assert.ok(phone?.userData.previewAccessory);
    assert.ok(phone.getObjectByName('display-phone-screen') && phone.getObjectByName('display-phone-lens'));
    assert.equal(dressed.getObjectByName('case-printed-shell').userData.printFace, product.previewModel.face);
    assert.equal(Boolean(dressed.getObjectByName('case-magsafe-relief')), product.previewModel.magSafe);
    if (product.previewModel.magSafe) {
      const ring = product.previewModel.magSafeRing;
      assert.equal(ray(dressed, ring.x + ring.radius, ring.y)[0].object.name, 'case-magsafe-relief', 'moulded ring remains visible above the printed shell');
      const stem = ring.alignment || {x:ring.x,y:ring.y-ring.radius-.65};
      assert.equal(ray(dressed, stem.x, stem.y)[0].object.name, 'case-magsafe-alignment');
    }
    for(const group of [bare,dressed]) group.traverse(mesh=>{
      mesh.geometry?.dispose();
      (Array.isArray(mesh.material)?mesh.material:[mesh.material]).forEach(material=>material?.dispose());
    });
  }
});
