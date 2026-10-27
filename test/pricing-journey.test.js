'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const { JSDOM } = require('jsdom');
const { startTestServer, createEvent, productDesignPayload, stubMockupApproval } = require('./helpers');
const { Gallery } = require('../public/js/product-gallery');

test('gallery prices survive cart and single-product quotes, Stripe Tax, signed payment and confirmation', async t => {
  process.env.STRIPE_PAYMENT_MODE = 'test';
  process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_pricing_journey';
  process.env.STRIPE_TEST_LOCAL_WEBHOOK_SECRET = 'whsec_pricing_journey';
  process.env.SHOP_PRODUCT_MARKUP_PERCENT = '50';
  process.env.SHOP_PAYMENT_RESERVE_PERCENT = '3.69';
  process.env.SHOP_PAYMENT_RESERVE_FIXED_CENTS = '49';
  const hosted = await startTestServer();
  stubMockupApproval(t);
  t.after(hosted.close);
  const { baseUrl } = hosted;
  const printful = require('../src/printful');
  const db = require('../src/db');
  require('./support/printful-fixtures').mockShippingRates(t, printful);
  t.mock.method(printful, 'getShippingCountries', async () => ['DE','FR','US'].map(code=>({code,name:code,states:[]})));
  let supplierDiscount = 0;
  t.mock.method(printful, 'estimateOrderCosts', async () => ({
    currency:'EUR',subtotal:21.35,discount:supplierDiscount,shipping:11.43,tax:0,vat:0,total:32.78-supplierDiscount,
  }));
  const sdk = new Stripe('sk_test_mock');
  const customers = new Map(), sessions = new Map(), requests = [];
  t.mock.method(Object.getPrototypeOf(sdk.customers), 'create', async params => {
    const id='cus_pricing'+(customers.size+1);customers.set(id,params);return {id};
  });
  t.mock.method(Object.getPrototypeOf(sdk.checkout.sessions), 'create', async params => {
    requests.push(params);
    const inclusive=params.line_items[0].price_data.tax_behavior==='inclusive';
    const rate=customers.get(params.customer).shipping.address.country==='US'?0:inclusive ? .19 : .20;
    const amount_subtotal=params.line_items.reduce((sum,item)=>sum+item.quantity*item.price_data.unit_amount,0);
    const shippingAmount=params.shipping_options[0].shipping_rate_data.fixed_amount.amount;
    const factor=inclusive?rate/(1+rate):rate;
    const tax=Math.round((amount_subtotal+shippingAmount)*factor);
    const shippingTax=Math.round(shippingAmount*factor);
    const id='cs_test_pricing'+requests.length;
    const session={id,url:'https://checkout.stripe.test/'+id,customer:params.customer,currency:'eur',
      amount_subtotal,amount_total:amount_subtotal+shippingAmount+(inclusive?0:tax),
      automatic_tax:{enabled:true,status:'complete'},
      total_details:{amount_tax:tax,amount_discount:0},
      shipping_cost:{amount_subtotal:shippingAmount,amount_tax:shippingTax,amount_total:shippingAmount+(inclusive?0:shippingTax)},
      line_items:{data:params.line_items.map(item=>({quantity:item.quantity,
        amount_subtotal:item.quantity*item.price_data.unit_amount,
        amount_total:item.quantity*item.price_data.unit_amount+(inclusive?0:Math.round(item.quantity*item.price_data.unit_amount*rate))}))},
    };
    sessions.set(id,session);return session;
  });
  async function post(path,body) {
    const response=await fetch(baseUrl+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const result=await response.json();
    assert.equal(response.status,200,JSON.stringify(result));
    return result;
  }
  for(const [country,cart] of ['DE','FR','US'].flatMap(country=>[[country,true],[country,false]])) await t.test(country+(cart?' cart':' single'), async () => {
    const event=await createEvent(baseUrl,{title:'Preisvergleich '+country});
    const catalog=await (await fetch(baseUrl+'/api/events/'+event.slug+'/configurator?restore=1')).json();
    const mugProduct=catalog.products.find(x=>x.key==='white-glossy-mug-duo-11oz');
    const posterProduct=catalog.products.find(x=>x.key==='matte-poster-30x40cm');
    assert.equal(mugProduct.price.unitGrossCents,1107);
    assert.equal(posterProduct.price.unitGrossCents,1957);
    const dom=new JSDOM('<section><div data-gallery-filters></div><div data-gallery-grid></div></section>', {pretendToBeVisual:true});
    const translate=(text,values={})=>text.replace(/\{\{(\w+)\}\}/g,(_,key)=>values[key]);
    const gallery=new Gallery({element:dom.window.document.querySelector('section'),products:[mugProduct,posterProduct],
      prepare:async product=>({productKey:product.key,orientation:product.defaultOrientation,designs:{default:[]}}),
      getView:x=>x,configureFlat(){},paintFlat(){},createMug:()=>({resize(){},destroy(){}}),
      onChoose(){},onAdd(){},
      i18n:{t:translate,setText:(node,text,values)=>{node.textContent=translate(text,values);},
        setAttribute:(node,key,text,values)=>node.setAttribute(key,translate(text,values))},
    });
    await gallery.queue;
    assert.match(gallery.cards[0].price.textContent,/11,07/);
    assert.match(gallery.cards[1].price.textContent,/19,57/);
    gallery.destroy();dom.window.close();
    const ids=[];
    for(const product of cart?[mugProduct,posterProduct]:[mugProduct]) {
      const response=await fetch(baseUrl+'/api/events/'+event.slug+'/configurations',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({
          productKey:product.key,quantity:1,theme:'pastel',words:[['liebe',3],['glück',2]],...productDesignPayload(product.key),
        })});
      assert.equal(response.status,201);ids.push((await response.json()).id);
    }
    const api='/api/events/'+event.slug+(cart?'/cart/':'/configurations/'+ids[0]+'/');
    const recipient={name:'Preis Test',address1:'Musterweg 1',city:'Berlin',zip:'10115',country_code:country};
    const body={configurationIds:ids,shipments:[{items:ids.map((configurationId,index)=>({configurationId,quantity:index===0?2:1})),
      quantity:cart?3:2,recipient}],itemsCents:1,unitPriceCents:1};
    const initial=(await post(api+'estimate-costs',body)).quote;
    assert.equal(initial.taxBehavior,country==='DE'?'inclusive':'exclusive');
    assert.equal(initial.itemsCents,country==='DE'?(cart?4171:2214):(cart?3505:1860));
    assert.equal(initial.shippingCents,country==='DE'?1484:1247);
    assert.equal(initial.pricedItems[0].unitGrossCents,1107);
    supplierDiscount=2;
    const prepared=(await post(api+'checkout',{configurationIds:ids,quoteId:initial.id,intent:'prepare'})).quote;
    assert.equal(prepared.checkoutPrepared,true);
    assert.equal(prepared.itemsCents,initial.itemsCents,'supplier discounts do not change customer prices');
    const expectedTotal=country==='DE'?(cart?5655:3698):country==='FR'?(cart?5702:3728):(cart?4752:3107);
    assert.equal(prepared.totalCents,expectedTotal);
    assert.equal(prepared.grossItemsCents+prepared.grossShippingCents,expectedTotal);
    const params=requests.at(-1);
    assert.deepEqual(params.automatic_tax,{enabled:true});
    assert.equal(params.line_items.length,cart?2:1);
    assert.deepEqual(params.line_items.map(x=>x.quantity),cart?[2,1]:[2]);
    assert.deepEqual(params.line_items.map(x=>x.price_data.unit_amount),
      country==='DE'?(cart?[1107,1957]:[1107]):(cart?[930,1645]:[930]));
    assert.equal(params.shipping_options[0].shipping_rate_data.display_name,'Versand');
    const checkout=await post(api+'checkout',{configurationIds:ids,quoteId:initial.id});
    assert.equal(requests.at(-1),params,'the displayed Session is reused for payment');
    const id=checkout.url.split('/').at(-1);
    const session=sessions.get(id);
    const pending=await db.getOrderBySessionId(id);
    const eventBody=JSON.stringify({id:'evt_pricing_'+country+'_'+cart,type:'checkout.session.completed',livemode:false,
      data:{object:{...session,payment_status:'paid',payment_intent:'pi_pricing_'+country+'_'+cart,
        customer_details:{email:'pricing@example.invalid'},metadata:params.metadata}}});
    const signature=Stripe.webhooks.generateTestHeaderString({payload:eventBody,secret:process.env.STRIPE_TEST_LOCAL_WEBHOOK_SECRET});
    const paid=await fetch(baseUrl+'/webhook/stripe',{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':signature},body:eventBody});
    assert.equal(paid.status,200,await paid.text());
    const order=await db.getOrderBySessionId(id);
    assert.equal(order.status,'paid_test');
    assert.equal(order.total_cents,expectedTotal);
    assert.equal(order.tax_cents,session.total_details.amount_tax);
    const status=await (await fetch(baseUrl+'/api/events/'+event.slug+'/orders/status?session_id='+id)).json();
    assert.equal(status.totalCents,expectedTotal);
    assert.equal(status.netShippingCents,country==='DE'?1484-session.shipping_cost.amount_tax:1247);
    const jobs=await hosted.query('SELECT * FROM email_jobs WHERE order_id=$1 AND kind=$2',[pending.id,'order_confirmation']);
    assert.equal(jobs.rows.length,1);
    const mail=JSON.stringify(jobs.rows[0]);
    assert.match(mail,/Davon MwSt\./);
    assert.match(mail,new RegExp((expectedTotal/100).toFixed(2).replace('.',',')));
    assert.match(mail,/Versand/);
    supplierDiscount=0;
  });
});
