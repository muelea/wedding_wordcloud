'use strict';
const crypto = require('node:crypto');
const { createService } = require('../../src/printfulMockups');
const { getProduct } = require('../../src/products');
const { productDesignPayload } = require('../helpers');
const clone = value => value == null ? value : structuredClone(value);

function memoryRepository() {
  const jobs = new Map(), budgets = new Map(), configurations = new Map(), prepared = new Map();
  const budget = scope => {
    if (!budgets.has(scope)) budgets.set(scope,{ nextCreate: 0, nextRead: 0, until: 0, lease: null });
    return budgets.get(scope);
  };
  return { jobs, budgets, configurations, prepared,
    async claimPreparedPrintFile(candidate) {
      const key=candidate.configurationId+':'+candidate.surfaceKey;
      let row=prepared.get(key);
      if(!row) { row={id:candidate.id,configuration_id:candidate.configurationId,surface_key:candidate.surfaceKey,
        spec_hash:candidate.specHash,object_key:candidate.objectKey,lease:candidate.lease,status:'uploading'};prepared.set(key,row); }
      return clone(row);
    },
    async savePreparedPrintFile(id,lease,sha256,byteSize,active=false) {
      const row=[...prepared.values()].find(value=>value.id===id);Object.assign(row,{sha256,byte_size:byteSize,status:active?'active':'uploading'});return clone(row);
    },
    async releasePreparedPrintFile() {},
    async getMockupConfiguration(id) { return clone(configurations.get(id)); },
    async enqueueMockupJob(job,{refresh=false}={}) {
      const command = [...jobs.values()].find(item => item.scope===job.scope && item.mode===job.mode &&
        item.configurationId===job.configurationId && (item.requestId===job.requestId || item.requestIds?.includes(job.requestId)));
      if (command) return clone(command);
      const previous = [...jobs.values()].reverse().find(item => item.scope===job.scope && item.mode===job.mode && item.cacheKey===job.cacheKey && item.expiresAt>job.createdAt);
      if (previous && previous.status!=='failed' && !(refresh && previous.status==='completed')) {
        const requestIds=[...new Set([previous.requestId,...(previous.requestIds||[]),job.requestId])];
        if(requestIds.length>64)return null;
        previous.requestIds=requestIds;return clone(previous);
      }
      if ([...jobs.values()].filter(item=>item.scope===job.scope&&!['completed','failed'].includes(item.status)).length>=64) return null;
      const active=[...jobs.values()].filter(item=>item.scope===job.scope&&!['completed','failed'].includes(item.status)).length;
      if(Number.isFinite(job.latestStartAt)&&Math.max(job.createdAt,budget(job.scope).nextCreate)+active*30500>job.latestStartAt)return null;
      budget(job.scope); jobs.set(job.id,clone(job)); return clone(job);
    },
    async getNextMockupJobAt({scope,operator,now}) {
      const jobsDue=[...jobs.values()].filter(item=>item.scope===scope&&(item.mode==='customer'||operator)&&
        (!['completed','failed'].includes(item.status)||item.sourceObjectKeys.length));
      return jobsDue.length ? Math.max(now,Math.min(...jobsDue.map(item=>item.nextAt)),budget(scope).until) : null;
    },
    async getMockupJob(id) { return clone(jobs.get(id)); },
    async claimMockupJob({scope,lease,now,leaseMs,operator}) {
      const b=budget(scope); if (b.until>now) return null;
      const job=[...jobs.values()].filter(item=>item.scope===scope&&item.nextAt<=now&&
        (item.mode==='customer'||operator)&&(!['completed','failed'].includes(item.status)||item.sourceObjectKeys.length))
        .sort((a,b)=>a.nextAt-b.nextAt||a.createdAt-b.createdAt)[0];
      if (!job) return null; b.lease=lease;b.until=now+leaseMs;return clone(job);
    },
    async saveMockupJob(job,lease,now) {
      const b=budget(job.scope); if (b.lease!==lease||b.until<=now) return false;
      jobs.set(job.id,clone({...job,requestIds:jobs.get(job.id)?.requestIds||[job.requestId]})); return true;
    },
    async renewMockupLease(scope,id,lease,now,leaseMs) {
      const b=budget(scope); if(b.lease!==lease||b.until<=now)return false;b.until=now+leaseMs;return true;
    },
    async releaseMockupLease(scope,id,lease) { const b=budget(scope);if(b.lease===lease){b.lease=null;b.until=0;} },
    async reserveMockupRequest(scope,lease,now,kind) {
      const b=budget(scope);if(b.lease!==lease||b.until<=now)throw Object.assign(new Error('lease lost'),{code:'MOCKUP_LEASE_LOST'});
      const key=kind==='create'?'nextCreate':'nextRead';if(b[key]>now)return b[key];b[key]=now+(kind==='create'?30500:1000);return now;
    },
    async deferMockupRequests(scope,lease,until,kind) {const b=budget(scope);if(b.lease===lease){const key=kind==='create'?'nextCreate':'nextRead';b[key]=Math.max(b[key],until);} },
    async pruneMockupJobs(now) { for(const [id,job]of jobs)if(job.expiresAt<=now)jobs.delete(id); },
  };
}
function harness(options={}) {
  const product=getProduct(options.productKey||'cork-back-coaster');
  let time=options.time??1_000_000;
  const repository=options.repository||memoryRepository();
  const uploaded=[],removed=[],payloads=[],reads=[],createReplies=[],pollReplies=[];
  const provider={
    async getCatalogProductMockupStyles(){return product.printful.placements.map((placement,index)=>({placement,
      technique:product.printful.technique, print_area_width:product.printFile.width/product.printFile.dpi,
      print_area_height:product.printFile.height/product.printFile.dpi, print_area_type:'simple',mockup_styles:[{id:index+1}]}));},
    async createMockupTasks(payload){payloads.push(payload);const next=createReplies.shift();if(next instanceof Error)throw next;return next||[{id:payloads.length,status:'pending'}];},
    async getMockupTasks(ids){reads.push(ids);const next=pollReplies.shift();if(next instanceof Error)throw next;return next||ids.map(id=>({id,status:'completed',catalog_variant_mockups:[{
      catalog_variant_id:product.printful.variantId,mockups:product.printful.placements.map(placement=>({placement,style_id:1,mockup_url:'https://printful-upload.s3-accelerate.amazonaws.com/tmp/product.png'})),
    }]}));},
  };
  const settings={now:()=>time,scope:'a'.repeat(64),autoStart:false,operatorEnabled:()=>true,repository,
    printfulClient:provider,renderPng:async()=>Buffer.from('PNG'),storageClient:{
      async upload(key,bytes,mime){uploaded.push({key,bytes,mime});},async remove(key){removed.push(key);},
      async createSignedUrl(key){return 'https://storage.example.test/'+key;},
    },...options};
  const service=createService(settings);
  function configuration(word='Liebe') {
    const designs=productDesignPayload(product.key,product.defaultOrientation).designs;
    for(const design of Object.values(designs))design[0].text=word;
    const value={id:crypto.randomBytes(12).toString('base64url'),event_id:1,product_key:product.key,
      printful_variant_id:product.printful.variantId,orientation:product.defaultOrientation,
      print_width:product.printFile.width,print_height:product.printFile.height,
      design_json:JSON.stringify({version:2,surfaces:designs})};
    repository.configurations?.set(value.id,value);return value;
  }
  return {service,settings,product,repository,uploaded,removed,payloads,reads,createReplies,pollReplies,configuration,
    advance(ms){time+=ms;},now:()=>time,
    async run(count=1){await service.runDue({maxJobs:count});},
    restart(){return createService(settings);},
  };
}
module.exports={harness,memoryRepository};
