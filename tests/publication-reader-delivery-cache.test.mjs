import assert from 'node:assert/strict';
import test from 'node:test';
import { handlePublicationReaderDeliveryCacheWebhook } from '../dist-runtime/publication-reader-delivery-cache.js';

const ORIGIN='https://domnkr.test';

class MockStatement{
  constructor(db,query){this.db=db;this.query=query.replace(/\s+/g,' ').trim();this.values=[];}
  bind(...values){this.values=values;return this;}
  async first(){
    this.db.reads.push({query:this.query,values:[...this.values]});
    if(this.query.includes('FROM channel_access_state WHERE user_telegram_id=?'))return null;
    if(this.query==='SELECT telegram_file_id FROM publication_assets WHERE id=? LIMIT 1'){
      this.db.cacheReads+=1;
      const warmed=this.db.waitedFileId&&this.db.cacheReads>1?this.db.waitedFileId:null;
      return{telegram_file_id:warmed??this.db.asset.telegram_file_id};
    }
    if(this.query.includes('SELECT p.status,g.status AS gate_status'))return{status:'published',gate_status:'sent',gate_message_id:77};
    return null;
  }
  async all(){this.db.reads.push({query:this.query,values:[...this.values]});return{results:[]};}
  async run(){
    this.db.operations.push({query:this.query,values:[...this.values]});
    if(this.query.startsWith('INSERT INTO publication_asset_cache_locks'))return{success:true,meta:{changes:this.db.leaseAvailable?1:0},results:[]};
    if(this.query.startsWith('UPDATE publication_assets SET telegram_file_id=NULL')){
      if(!this.values[1]||this.db.asset.telegram_file_id===this.values[1])this.db.asset.telegram_file_id=null;
    }
    if(this.query.startsWith('UPDATE publication_assets SET telegram_file_id=?'))this.db.asset.telegram_file_id=String(this.values[0]);
    return{success:true,meta:{changes:1},results:[]};
  }
}

class MockDB{
  constructor({thanked=true,cached='telegram-cached-file',waitedFileId=null,leaseAvailable=true,returning=true}={}){
    this.thanked=thanked;this.waitedFileId=waitedFileId;this.leaseAvailable=leaseAvailable;this.returning=returning;this.cacheReads=0;
    this.publication={id:7,status:'published',internal_title:'Глава 10',gate_status:'sent',gate_message_id:77};
    this.asset={id:11,publication_id:7,file_name:'chapter.epub',mime_type:'application/epub+zip',r2_key:'publications/7/files/chapter.epub',size_bytes:1234,telegram_file_id:cached,sort_order:0};
    this.operations=[];this.reads=[];this.batchCalls=[];
  }
  prepare(query){return new MockStatement(this,query);}
  async batch(statements){
    this.batchCalls.push(statements.map((statement)=>({query:statement.query,values:[...statement.values]})));
    return statements.map((statement)=>{
      const q=statement.query;
      if(q.includes('FROM publications p LEFT JOIN publication_comment_gates')&&q.includes('WHERE p.id=?'))return{success:true,results:[{...this.publication}]};
      if(q.includes('FROM publication_assets WHERE publication_id=?'))return{success:true,results:[{...this.asset}]};
      if(q.includes('FROM publication_thanks WHERE publication_id=?'))return{success:true,results:this.thanked?[{publication_id:7}]:[]};
      if(q.includes('FROM publication_deliveries WHERE publication_id=?'))return{success:true,results:[]};
      if(q.includes('SELECT 1 AS active FROM publication_reader_events'))return{success:true,results:this.returning?[{active:1}]:[]};
      this.operations.push({query:q,values:[...statement.values],batch:true});
      return{success:true,meta:{changes:1},results:[]};
    });
  }
}

class MockBucket{
  constructor(){this.gets=[];}
  async get(key){this.gets.push(key);const bytes=new TextEncoder().encode('epub');return{size:bytes.byteLength,httpMetadata:{contentType:'application/epub+zip'},blob:async()=>new Blob([bytes],{type:'application/epub+zip'}),arrayBuffer:async()=>bytes.buffer};}
}

function env(db,bucket=new MockBucket()){
  return{DB:db,FILES:bucket,TELEGRAM_BOT_TOKEN:'unit-test-token',TELEGRAM_WEBHOOK_SECRET:'unit-test-secret',BOT_USERNAME:'domnekromanta_bot',PUBLISH_CHANNEL_ID:'@domnekromanta',ADMIN_TELEGRAM_IDS:'4242'};
}
function ctx(){return{promises:[],waitUntil(promise){this.promises.push(promise);}};}
async function flush(execution){for(let i=0;i<8;i+=1){const pending=execution.promises.splice(0);if(!pending.length)return;await Promise.all(pending);}}
function webhook(update,secret='unit-test-secret'){return new Request(`${ORIGIN}/telegram/webhook`,{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':secret},body:JSON.stringify(update)});}

async function withTelegramMock(fn,{staleFileId=null}={}){
  const original=globalThis.fetch;const calls=[];let messageId=100;
  globalThis.fetch=async(url,options={})=>{
    const call={url:String(url),options};calls.push(call);
    const method=String(url).split('/').pop();
    if(method==='getChatMember')return new Response(JSON.stringify({ok:true,result:{status:'member',user:{id:4242}}}),{headers:{'content-type':'application/json'}});
    if(method==='answerCallbackQuery')return new Response(JSON.stringify({ok:true,result:true}),{headers:{'content-type':'application/json'}});
    if(method==='sendDocument'){
      if(typeof options.body==='string'){
        const payload=JSON.parse(options.body);
        if(staleFileId&&payload.document===staleFileId)return new Response(JSON.stringify({ok:false,error_code:400,description:'Bad Request: wrong file identifier/HTTP URL specified'}),{status:400,headers:{'content-type':'application/json'}});
        return new Response(JSON.stringify({ok:true,result:{message_id:++messageId,chat:{id:4242,type:'private'},document:{file_id:String(payload.document)}}}),{headers:{'content-type':'application/json'}});
      }
      return new Response(JSON.stringify({ok:true,result:{message_id:++messageId,chat:{id:4242,type:'private'},document:{file_id:'telegram-repaired-file'}}}),{headers:{'content-type':'application/json'}});
    }
    return new Response(JSON.stringify({ok:true,result:{message_id:++messageId,chat:{id:4242,type:'private'}}}),{headers:{'content-type':'application/json'}});
  };
  try{return await fn(calls);}finally{globalThis.fetch=original;}
}

test('invalid webhook secret is rejected before cache or Telegram side effects',async()=>{
  const db=new MockDB();const bucket=new MockBucket();
  const response=await handlePublicationReaderDeliveryCacheWebhook(webhook({message:{chat:{id:4242,type:'private'},from:{id:4242,first_name:'Reader'},text:'/start dl_7'}},'wrong'),env(db,bucket),ctx());
  assert.ok(response);assert.equal(response.status,403);assert.equal(db.operations.length,0);assert.equal(bucket.gets.length,0);
});

test('stale Telegram file_id self-heals from R2 and stores the replacement cache id',async()=>{
  const db=new MockDB({cached:'stale-file'});const bucket=new MockBucket();const execution=ctx();
  await withTelegramMock(async(calls)=>{
    const response=await handlePublicationReaderDeliveryCacheWebhook(webhook({message:{message_id:1,chat:{id:4242,type:'private'},from:{id:4242,first_name:'Reader',username:'reader'},text:'/start dl_7'}}),env(db,bucket),execution);
    assert.ok(response);assert.equal(response.status,200);await flush(execution);
    const documentCalls=calls.filter((call)=>call.url.endsWith('/sendDocument'));
    assert.equal(documentCalls.length,2);
    assert.equal(typeof documentCalls[0].options.body,'string');
    assert.ok(documentCalls[1].options.body instanceof FormData);
    assert.deepEqual(bucket.gets,['publications/7/files/chapter.epub']);
    assert.equal(db.asset.telegram_file_id,'telegram-repaired-file');
    assert.ok(db.operations.some((row)=>row.query.startsWith('UPDATE publication_assets SET telegram_file_id=NULL')));
    assert.ok(db.operations.some((row)=>row.query.startsWith('INSERT INTO publication_asset_cache_locks')));
    assert.ok(db.batchCalls.some((batch)=>batch.some((row)=>row.query.includes('delivery_success')&&row.values.some((value)=>String(value).includes('"cache":"repaired"')))));
  },{staleFileId:'stale-file'});
});

test('cold-cache loser waits for the global asset cache and reuses the winning file_id without R2',async()=>{
  const db=new MockDB({cached:null,waitedFileId:'telegram-warmed-elsewhere',leaseAvailable:false});const bucket=new MockBucket();const execution=ctx();
  await withTelegramMock(async(calls)=>{
    const response=await handlePublicationReaderDeliveryCacheWebhook(webhook({message:{message_id:1,chat:{id:4242,type:'private'},from:{id:4242,first_name:'Reader'},text:'/start dl_7'}}),env(db,bucket),execution);
    assert.ok(response);await flush(execution);
    assert.equal(bucket.gets.length,0);
    assert.ok(db.operations.some((row)=>row.query.startsWith('INSERT INTO publication_asset_cache_locks')));
    const documentCall=calls.find((call)=>call.url.endsWith('/sendDocument'));assert.ok(documentCall);
    assert.equal(JSON.parse(String(documentCall.options.body)).document,'telegram-warmed-elsewhere');
    assert.ok(db.batchCalls.some((batch)=>batch.some((row)=>row.query.includes('delivery_success')&&row.values.some((value)=>String(value).includes('"cache":"waited"')))));
  });
});

test('direct deep-link on gated release still requires thank-you grant',async()=>{
  const db=new MockDB({thanked:false});const bucket=new MockBucket();const execution=ctx();
  await withTelegramMock(async(calls)=>{
    const response=await handlePublicationReaderDeliveryCacheWebhook(webhook({message:{message_id:1,chat:{id:4242,type:'private'},from:{id:4242,first_name:'Reader'},text:'/start dl_7'}}),env(db,bucket),execution);
    assert.ok(response);await flush(execution);
    assert.equal(calls.some((call)=>call.url.endsWith('/sendDocument')),false);
    const text=JSON.parse(String(calls.find((call)=>call.url.endsWith('/sendMessage')).options.body)).text;
    assert.match(text,/Сначала нажмите «❤️ Спасибо»/);
  });
});
