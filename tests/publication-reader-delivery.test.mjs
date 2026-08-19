import assert from 'node:assert/strict';
import test from 'node:test';
import { handlePublicationReaderDeliveryWebhook } from '../dist-runtime/publication-reader-delivery.js';

const ORIGIN='https://domnkr.test';

class MockStatement{
  constructor(db,query){this.db=db;this.query=query.replace(/\s+/g,' ').trim();this.values=[];}
  bind(...values){this.values=values;return this;}
  async first(){
    this.db.reads.push({query:this.query,values:[...this.values]});
    if(this.query.includes('SELECT value FROM app_settings')){
      if(this.values[0]==='publish_channel_id')return{value:'@domnekromanta'};
      return null;
    }
    if(this.query.includes('FROM channel_access_state WHERE user_telegram_id=?'))return null;
    if(this.query.includes('COUNT(*) AS count FROM publication_assets'))return{count:this.db.assets.length};
    if(this.query.includes('WHERE p.channel_message_id=?'))return Number(this.values[0])===123?{...this.db.publication}:null;
    if(this.query.includes('SELECT p.status,g.status AS gate_status'))return{status:'published',gate_status:'sent',gate_message_id:77};
    return null;
  }
  async all(){this.db.reads.push({query:this.query,values:[...this.values]});return{results:[]};}
  async run(){
    this.db.operations.push({query:this.query,values:[...this.values]});
    return{success:true,meta:{changes:1},results:[]};
  }
}
class MockDB{
  constructor({thanked=true}={}){
    this.thanked=thanked;
    this.publication={id:7,status:'published',internal_title:'Глава 10',channel_message_id:123,discussion_message_id:null,gate_status:null,gate_message_id:null};
    this.assets=[{id:11,publication_id:7,file_name:'chapter.epub',mime_type:'application/epub+zip',r2_key:'publications/7/files/chapter.epub',size_bytes:1234,telegram_file_id:'telegram-cached-file',sort_order:0}];
    this.operations=[];this.reads=[];this.batchCalls=[];
  }
  prepare(query){return new MockStatement(this,query);}
  async batch(statements){
    this.batchCalls.push(statements.map((statement)=>({query:statement.query,values:[...statement.values]})));
    return statements.map((statement)=>{
      const q=statement.query;
      if(q.includes('FROM publications p LEFT JOIN publication_comment_gates')&&q.includes('WHERE p.id=?'))return{success:true,results:[{...this.publication,gate_status:'sent',gate_message_id:77}]};
      if(q.includes('FROM publication_assets WHERE publication_id=?'))return{success:true,results:this.assets.map((row)=>({...row}))};
      if(q.includes('FROM publication_thanks WHERE publication_id=?'))return{success:true,results:this.thanked?[{publication_id:7}]:[]};
      if(q.includes('FROM publication_deliveries WHERE publication_id=?'))return{success:true,results:[]};
      this.operations.push({query:q,values:[...statement.values],batch:true});
      return{success:true,meta:{changes:1},results:[]};
    });
  }
}
function env(db){return{DB:db,TELEGRAM_BOT_TOKEN:'123:test',TELEGRAM_WEBHOOK_SECRET:'secret',BOT_USERNAME:'domnekromanta_bot',PUBLISH_CHANNEL_ID:'@domnekromanta'};}
function ctx(){return{promises:[],waitUntil(promise){this.promises.push(promise);}};}
async function flush(execution){for(let i=0;i<4;i+=1){const pending=[...execution.promises];if(!pending.length)return;await Promise.all(pending);}}

async function withTelegramMock(fn){
  const original=globalThis.fetch;const calls=[];let messageId=100;
  globalThis.fetch=async(url,options={})=>{
    calls.push({url:String(url),options});
    const method=String(url).split('/').pop();
    if(method==='getChat')return new Response(JSON.stringify({ok:true,result:{id:-100,linked_chat_id:-200}}),{headers:{'content-type':'application/json'}});
    if(method==='getChatMember')return new Response(JSON.stringify({ok:true,result:{status:'member',user:{id:4242}}}),{headers:{'content-type':'application/json'}});
    if(method==='answerCallbackQuery')return new Response(JSON.stringify({ok:true,result:true}),{headers:{'content-type':'application/json'}});
    if(method==='sendDocument')return new Response(JSON.stringify({ok:true,result:{message_id:++messageId,chat:{id:4242,type:'private'},document:{file_id:'telegram-cached-file'}}}),{headers:{'content-type':'application/json'}});
    return new Response(JSON.stringify({ok:true,result:{message_id:++messageId,chat:{id:4242,type:'private'}}}),{headers:{'content-type':'application/json'}});
  };
  try{return await fn(calls);}finally{globalThis.fetch=original;}
}
function webhook(update){return new Request(`${ORIGIN}/telegram/webhook`,{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'secret'},body:JSON.stringify(update)});}

test('new automatic forward creates one thank-you gate comment and no public document',async()=>{
  const db=new MockDB();const execution=ctx();
  await withTelegramMock(async(calls)=>{
    const response=await handlePublicationReaderDeliveryWebhook(webhook({message:{message_id:55,chat:{id:-200,type:'supergroup'},is_automatic_forward:true,forward_origin:{type:'channel',message_id:123}}}),env(db),execution);
    assert.ok(response);assert.equal(response.status,200);
    const methods=calls.map((call)=>call.url.split('/').pop());
    assert.deepEqual(methods,['getChat','sendMessage']);
    const body=JSON.parse(String(calls.find((call)=>call.url.endsWith('/sendMessage')).options.body));
    assert.match(body.text,/Нажмите «Спасибо»/);
    assert.match(JSON.stringify(body.reply_markup),/gate-thanks:7/);
    assert.doesNotMatch(JSON.stringify(body.reply_markup),/gate-download:7/);
    assert.equal(methods.includes('sendDocument'),false);
  });
});

test('thank gate stores grant before redirecting user to bot',async()=>{
  const db=new MockDB();const execution=ctx();
  await withTelegramMock(async(calls)=>{
    const response=await handlePublicationReaderDeliveryWebhook(webhook({callback_query:{id:'cb-1',from:{id:4242,first_name:'Reader',username:'reader'},data:'gate-thanks:7',message:{message_id:77,chat:{id:-200,type:'supergroup'}}}}),env(db),execution);
    assert.ok(response);assert.equal(response.status,200);await flush(execution);
    assert.ok(db.batchCalls.some((batch)=>batch.some((row)=>row.query.startsWith('INSERT OR IGNORE INTO publication_thanks'))));
    const answer=calls.find((call)=>call.url.endsWith('/answerCallbackQuery'));assert.ok(answer);
    const payload=JSON.parse(String(answer.options.body));assert.match(payload.url,/start=dl_7/);
  });
});

test('direct deep-link on gated release is blocked until thank-you click',async()=>{
  const db=new MockDB({thanked:false});const execution=ctx();
  await withTelegramMock(async(calls)=>{
    const response=await handlePublicationReaderDeliveryWebhook(webhook({message:{message_id:1,chat:{id:4242,type:'private'},from:{id:4242,first_name:'Reader'},text:'/start dl_7'}}),env(db),execution);
    assert.ok(response);await flush(execution);
    assert.equal(calls.some((call)=>call.url.endsWith('/sendDocument')),false);
    const messageCall=calls.find((call)=>call.url.endsWith('/sendMessage'));assert.ok(messageCall);
    assert.match(JSON.parse(String(messageCall.options.body)).text,/Сначала нажмите «❤️ Спасибо»/);
    assert.ok(db.operations.some((row)=>row.values.includes('thank_you_required')));
  });
});

test('thanked subscriber receives cached Telegram file and optimized delivery events',async()=>{
  const db=new MockDB({thanked:true});const execution=ctx();
  await withTelegramMock(async(calls)=>{
    const response=await handlePublicationReaderDeliveryWebhook(webhook({message:{message_id:1,chat:{id:4242,type:'private'},from:{id:4242,first_name:'Reader',username:'reader'},text:'/start dl_7'}}),env(db),execution);
    assert.ok(response);await flush(execution);
    const methods=calls.map((call)=>call.url.split('/').pop());
    assert.ok(methods.includes('getChatMember'));
    assert.ok(methods.includes('sendDocument'));
    const documentCall=calls.find((call)=>call.url.endsWith('/sendDocument'));assert.match(String(documentCall.options.body),/telegram-cached-file/);
    assert.ok(db.operations.some((row)=>row.values.includes('delivery_started')));
    assert.ok(db.batchCalls.some((batch)=>batch.some((row)=>row.query.includes('delivery_success'))));
    assert.ok(db.batchCalls.some((batch)=>batch.some((row)=>row.query.includes("SET status='delivered'"))));
  });
});