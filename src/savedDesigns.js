'use strict';

const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { createCanvas, loadImage } = require('canvas');
const db = require('./db');
const auth = require('./accountAuth');
const { getProduct, resolveProductOrientation } = require('./products');
const { normalizeDesign, normalizeSnapshotWords } = require('./routes/events');
const { buildProviderPrintSvg } = require('./mugPrint');
const { withRenderSlot } = require('./printArtifacts');
const I18n = require('./i18n');

const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
let testStorage = null;
function storage() {
  if (process.env.NODE_ENV === 'test') {
    if (!testStorage) throw db.accountError('account_storage_unavailable',503);
    return testStorage;
  }
  const client=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    global:{fetch:(input,init={})=>fetch(input,{...init,signal:init.signal?
      AbortSignal.any([init.signal,AbortSignal.timeout(3500)]):AbortSignal.timeout(3500)})},
  }).storage.from(process.env.SUPABASE_DESIGNS_BUCKET||'wolkenworte-designs');
  return {
    async upload(key,bytes,type) { const {error}=await client.upload(key,bytes,{contentType:type,upsert:false,cacheControl:'0'}); if(error) throw db.accountError('account_storage_unavailable',503); },
    async download(key) { const {data,error}=await client.download(key); if(error||!data) throw db.accountError('account_storage_unavailable',503); return Buffer.from(await data.arrayBuffer()); },
    async remove(key) { const {error}=await client.remove([key]); if(error) throw db.accountError('account_storage_unavailable',503); },
    async removeMany(keys) { const {error}=await client.remove(keys); if(error) throw db.accountError('account_storage_unavailable',503); },
  };
}

function designName(value) {
  if(typeof value!=='string') throw db.accountError('invalid_design_name',400);
  const name=value.normalize('NFC').replace(/[\x00-\x1f\x7f]/g,'').trim().replace(/\s+/g,' ');
  if(!name||name.length>80) throw db.accountError('invalid_design_name',400);
  return name;
}

function normalizeSnapshot(raw,locale='de') {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)) throw db.accountError('invalid_design',400);
  const product=resolveProductOrientation(getProduct(raw.productKey),raw.orientation);
  if(!product||!product.themes.some(t=>t.key===raw.theme)) throw db.accountError('invalid_design',400);
  const words=normalizeSnapshotWords(raw.words,I18n.normalizeLocale(locale),true);
  if(!words||!raw.designs||Object.keys(raw.designs).some(k=>!product.printSurfaces.some(s=>s.key===k))) throw db.accountError('invalid_design',400);
  const imageState={sources:new Set(),totalBytes:0};
  const normalize=(items,width,height,area)=> {
    if(Array.isArray(items)&&items.length===0) return [];
    const result=normalizeDesign(items,width,height,area,locale,imageState);
    if(!result) throw db.accountError('invalid_design',400);
    return result;
  };
  const designs=Object.fromEntries(product.printSurfaces.map(surface=>[surface.key,
    normalize(raw.designs[surface.key],product.printFile.width,product.printFile.height,product.designSafeAreas[surface.key])]));
  let colors=raw.customColors||[];
  if(!Array.isArray(colors)||colors.length>8||colors.some(c=>typeof c!=='string'||!/^#[0-9a-f]{6}$/i.test(c))) throw db.accountError('invalid_design',400);
  if(!colors.length) colors=product.themes.find(theme=>theme.key==='custom')?.colors||['#c2185b'];
  const transfer={version:1,surfaces:[],layouts:[]};
  if(raw.productDesignState!=null) {
    const state=raw.productDesignState;
    if(state.version!==1||!Array.isArray(state.surfaces)||state.surfaces.length>2||!Array.isArray(state.layouts)||state.layouts.length>32) throw db.accountError('invalid_design',400);
    transfer.surfaces=state.surfaces.map(surface=> {
      const area=surface?.area;
      if(!area||!['x','y','width','height'].every(k=>Number.isFinite(area[k]))||area.x<0||area.y<0||area.width<24||area.height<24||area.x+area.width>30000||area.y+area.height>30000) throw db.accountError('invalid_design',400);
      const clean=Object.fromEntries(['x','y','width','height'].map(k=>[k,area[k]]));
      return {area:clean,design:normalize(surface.design,area.x+area.width,area.y+area.height,clean)};
    });
    transfer.layouts=state.layouts.map(layout=> {
      if(!resolveProductOrientation(getProduct(layout.productKey),layout.orientation)||!Array.isArray(layout.surfaces)||layout.surfaces.length>2) throw db.accountError('invalid_design',400);
      return {productKey:layout.productKey,orientation:layout.orientation,surfaces:layout.surfaces.map(items=> {
        if(!Array.isArray(items)||items.length>1200) throw db.accountError('invalid_design',400);
        return items.map(item=> {
          if(!item||typeof item.id!=='string'||item.id.length>64||!['text','icon','image'].includes(item.type||'text')) throw db.accountError('invalid_design',400);
          const clean={id:item.id,type:item.type||'text'};
          for(const key of ['x','y','fontSize','size','width','height','angle','layoutFontSize']) {
            if(item[key]!==undefined) {
              if(!Number.isFinite(item[key])||Math.abs(item[key])>30000) throw db.accountError('invalid_design',400);
              clean[key]=item[key];
            }
          }
          if(typeof item.layoutFingerprint==='string') clean.layoutFingerprint=item.layoutFingerprint.slice(0,128);
          return clean;
        });
      })};
    });
  }
  return {version:1,productKey:product.key,orientation:product.orientation,theme:raw.theme,
    customColors:colors.map(c=>c.toLowerCase()),words,designs,productDesignState:transfer,
    currentDesignEdited:true,locale:I18n.normalizeLocale(locale)};
}

function encodeSnapshot(snapshot) {
  const images=[];
  const compact=JSON.parse(JSON.stringify(snapshot,(key,value)=> {
    if(key==='src'&&typeof value==='string'&&value.startsWith('data:image/')) {
      let index=images.indexOf(value);
      if(index<0) { index=images.length; images.push(value); }
      return `image:${index}`;
    }
    return value;
  }));
  const bytes=Buffer.from(JSON.stringify({version:1,images,snapshot:compact}));
  if(bytes.length>MAX_SNAPSHOT_BYTES) throw db.accountError('design_quota',413);
  return bytes;
}

function decodeSnapshot(bytes) {
  if(bytes.length>MAX_SNAPSHOT_BYTES) throw db.accountError('account_storage_unavailable',503);
  const packet=JSON.parse(bytes.toString());
  if(packet.version!==1||!Array.isArray(packet.images)||packet.images.length>4||!packet.snapshot) throw db.accountError('account_storage_unavailable',503);
  return JSON.parse(JSON.stringify(packet.snapshot),(key,value)=> {
    if(key==='src'&&typeof value==='string'&&/^image:[0-3]$/.test(value)) {
      const image=packet.images[Number(value.slice(6))];
      if(typeof image!=='string') throw db.accountError('account_storage_unavailable',503);
      return image;
    }
    return value;
  });
}

async function thumbnail(snapshot) {
  return withRenderSlot(async()=> {
    const product=resolveProductOrientation(getProduct(snapshot.productKey),snapshot.orientation);
    const width=product.printFile.width, height=product.printFile.height;
    const scale=Math.min(480/width,480/height);
    const canvas=createCanvas(Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale)));
    const context=canvas.getContext('2d');
    context.fillStyle='#fff'; context.fillRect(0,0,canvas.width,canvas.height);
    context.scale(canvas.width/width,canvas.height/height);
    const draw=async elements=> {
      if(!elements.length) return;
      let svg=buildProviderPrintSvg(product,elements);
      svg=svg.replace(/(<svg[^>]*\bwidth=")[^"]+"/,(_,p)=>`${p}${canvas.width}"`)
        .replace(/(<svg[^>]*\bheight=")[^"]+"/,(_,p)=>`${p}${canvas.height}"`);
      context.drawImage(await loadImage(Buffer.from(svg)),0,0,width,height);
    };
    let vectors=[];
    for(const item of snapshot.designs[product.printSurfaces[0].key]) {
      if(item.type!=='image') { vectors.push(item); continue; }
      await draw(vectors); vectors=[];
      const image=await loadImage(Buffer.from(item.src.slice(item.src.indexOf(',')+1),'base64'));
      context.save(); context.translate(item.x,item.y); context.rotate(item.angle*Math.PI/180);
      context.drawImage(image,-item.width/2,-item.height/2,item.width,item.height); context.restore();
    }
    await draw(vectors);
    return canvas.toBuffer('image/png');
  });
}

function summary(row) {
  const product=resolveProductOrientation(getProduct(row.product_key),row.orientation);
  return {id:row.id,name:row.name,productKey:row.product_key,productName:product?.displayName||product?.name||row.product_key,orientation:row.orientation,
    version:row.version,savedAt:row.saved_at,expiresAt:row.expires_at,byteSize:row.byte_size,
    previewUrl:`/api/account/designs/${row.id}/preview`};
}

async function drainObjects({accountId=null,maxObjects=4,deadline=Date.now()+14000}={}) {
  let removed=0;
  while(removed<maxObjects&&Date.now()+3800<deadline) {
    const objects=await db.claimDesignObjectDeletionBatch(accountId,Math.min(40,maxObjects-removed));
    if(!objects.length) break;
    const keys=objects.map(object=>object.object_key),lease=objects[0].lease;
    try {
      const store=storage();
      if(store.removeMany) await store.removeMany(keys);else await Promise.all(keys.map(key=>store.remove(key)));
      await db.finishDesignObjectDeletionBatch(keys,lease,true);removed+=keys.length;
    } catch { await db.finishDesignObjectDeletionBatch(keys,lease,false);break; }
  }
  return removed;
}

async function save(accountId,body,locale) {
  const name=designName(body.name);
  if(!auth.UUID.test(body.requestId||'')||!auth.UUID.test(body.designId||'')||!Number.isInteger(body.version)||body.version<0) throw db.accountError('invalid_request',400);
  const snapshot=normalizeSnapshot(body.snapshot,locale);
  const bytes=encodeSnapshot(snapshot);
  const preview=await thumbnail(snapshot);
  if(bytes.length+preview.length>MAX_SNAPSHOT_BYTES) throw db.accountError('design_quota',413);
  const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
  const prefix=`${accountId}/${body.requestId}`;
  const write=await db.reserveSavedDesignWrite({id:body.requestId,accountId,designId:body.designId,expectedVersion:body.version,
    name,productKey:snapshot.productKey,orientation:snapshot.orientation,sha256,byteSize:bytes.length+preview.length,
    snapshotKey:`${prefix}.json`,previewKey:`${prefix}.png`});
  if(write.status==='complete') {
    const row=await db.getSavedDesign(accountId,write.design_id);
    if(!row||row.version!==write.result_version) throw db.accountError('design_conflict');
    return summary(row);
  }
  // A second request may retry a completed response, but may not race an
  // in-flight upload or overwrite an immutable object with different bytes.
  if(write.snapshot_key!==`${prefix}.json`) throw db.accountError('design_conflict');
  let row;
  try {
    await storage().upload(write.snapshot_key,bytes,'application/json');
    await storage().upload(write.preview_key,preview,'image/png');
    row=await db.finishSavedDesignWrite(accountId,write.id);
  } catch(error) {
    const outcome=await db.failSavedDesignWrite(accountId,write.id,[write.snapshot_key,write.preview_key]);
    if(outcome.status==='complete') {
      // A lost COMMIT response is not an upload failure. Never remove files
      // referenced by a committed saved copy, including on a cleanup error.
      const committed=await db.getSavedDesign(accountId,write.design_id);
      if(committed?.snapshot_key===write.snapshot_key) return summary(committed);
      throw db.accountError('design_conflict');
    }
    // Best effort immediate removal. The ledger remains fenced for uploads
    // still completing at the provider, then maintenance retries durably.
    for(const key of outcome.keys) { try { await storage().remove(key); } catch {} }
    throw error.code ? error : db.accountError('account_storage_unavailable',503);
  }
  await drainObjects({accountId,maxObjects:2}).catch(()=>{});
  return summary(row);
}

async function load(accountId,id,{touch=false}={}) {
  if(!auth.UUID.test(id||'')) throw db.accountError('design_not_found',404);
  const row=await db.getSavedDesign(accountId,id);
  if(!row) throw db.accountError('design_not_found',404);
  const bytes=await storage().download(row.snapshot_key);
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==row.snapshot_sha256) throw db.accountError('account_storage_unavailable',503);
  const current=await db.getSavedDesign(accountId,id);
  if(!current) throw db.accountError('design_not_found',404);
  if(current.version!==row.version) throw db.accountError('design_conflict');
  const active=touch?await db.touchSavedDesign(accountId,id,row.version):row;
  if(!active) throw db.accountError('design_not_found',404);
  return {...summary(active),snapshot:decodeSnapshot(bytes)};
}

async function deleteAccount(accountId) {
  await db.beginDesignAccountDeletion(accountId);
  const job=await db.claimDesignAccountDeletion(accountId);
  if(job) {
    try { await auth.provider('deleteUser',{id:accountId}); await db.finishDesignAccountDeletion(accountId,job.lease,true); }
    catch { await db.finishDesignAccountDeletion(accountId,job.lease,false); }
  }
  await drainObjects({accountId,maxObjects:40,deadline:Date.now()+14000});
}

async function maintenance({deadline}) {
  if(!db.hasAccountSchema()||(process.env.NODE_ENV==='test'&&!testStorage)) return {designsExpired:0,accountsExpired:0};
  const result=await db.sweepDesignAccountRetention({deadline:Math.min(deadline-5100,Date.now()+5000)});
  if(Date.now()+5100<deadline&&auth.providerReady()) {
    const job=await db.claimDesignAccountDeletion();
    if(job) {
      try { await auth.provider('deleteUser',{id:job.account_id}); await db.finishDesignAccountDeletion(job.account_id,job.lease,true); }
      catch { await db.finishDesignAccountDeletion(job.account_id,job.lease,false); }
    }
  }
  result.objectsRemoved=await drainObjects({maxObjects:40,deadline});
  if(Date.now()+5100<deadline&&auth.providerReady()) {
    const page=await db.accountMaintenancePage();
    const data=await auth.provider('listUsers',{page});
    await db.discoverDesignAccounts(data.users||[]);
    await db.accountMaintenancePage((data.users||[]).length<50?1:page+1);
  }
  return result;
}

function setStorageForTests(adapter) {
  if(process.env.NODE_ENV!=='test') throw new Error('Design Storage overrides are test-only.');
  testStorage=adapter;
}
module.exports={MAX_SNAPSHOT_BYTES,designName,normalizeSnapshot,encodeSnapshot,decodeSnapshot,thumbnail,summary,
  storage,save,load,drainObjects,deleteAccount,maintenance,setStorageForTests};
