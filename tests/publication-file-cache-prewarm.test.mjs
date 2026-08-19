import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { handleWebAuth } from '../dist-runtime/web-auth.js';
import { handlePublicationFileCachePrewarm } from '../dist-runtime/publication-file-cache-prewarm.js';

const TOKEN='123456:test-token-for-unit-tests-only';
const ORIGIN='https://domnkr.test';

function telegramLoginUrl(){
  const fields={id:'424242',first_name:'Necromancer',username:'domnkr_test',auth_date:String(Math.floor(Date.now()/1000))};
  const dataCheckString=Object.entries(fields).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>`${key}=${value}`).join('\n');
  const secret=createHash('sha256').update(TOKEN).digest();
  const hash=createHmac('sha256',secret).update(dataCheckString).digest('hex');
  const url=new URL('/auth/telegram/callback',ORIGIN);
  for(const [key,value] of Object.entries(fields))url.searchParams.set(key,value);
  url.searchParams.set('hash',hash);return url;
}
async function adminCookie(){
  const response=await handleWebAuth(new Request(telegramLoginUrl()),{TELEGRAM_BOT_TOKEN:TOKEN,ADMIN_TELEGRAM_IDS:'424242',BOT_USERNAME:'domnekromanta_bot'});
  const raw=response?.headers.get('set-cookie');assert.ok(raw);return raw.split(';',1)[0];
}

class MockStatement{
  constructor(db,query){this.db=db;this.query=query.replace(/\s+/g,' ').trim();this.values=[];}
  bind(...values){this.values=values;return this;}
  async first(){
    this.db.reads.push({query:this.query,values:[...this.values]});
    if(this.query==='SELECT id,status FROM publications WHERE id=? LIMIT 1')return{id:7,status:'draft'};
    if(this.query==='SELECT telegram_file_id FROM publication_assets WHERE id=? LIMIT 1')return{telegram_file_id:this.db.asset.telegram_file_id};
    return null;
  }
  async all(){
    this.db.reads.push({query:this.query,values:[...this.values]});
    if(this.query.includes('FROM publication_assets WHERE publication_id=?'))return{results:[{...this.db.asset}]};
    return{results:[]};
  }
  async run(){
    this.db.operations.push({query:this.query,values:[...this.values]});
    if(this.query.startsWith('INSERT INTO publication_asset_cache_locks'))return{meta:{changes:1}};
    if(this.query.startsWith('UPDATE publication_assets SET telegram_file_id=?'))this.db.asset.telegram_file_id=String(this.values[0]);
    return{meta:{changes:1}};
  }
}
class MockDB{
  constructor(){this.asset={id:11,publication_id:7,file_name:'chapter.epub',mime_type:'application/epub+zip',r2_key:'publications/7/files/chapter.epub',size_bytes:4,telegram_file_id:null};this.operations=[];this.reads=[];}
  prepare(query){return new MockStatement(this,query);}
}
class MockBucket{
  constructor(){this.gets=[];}
  async get(key){this.gets.push(key);const bytes=new TextEncoder().encode('epub');return{size:bytes.byteLength,httpMetadata:{contentType:'application/epub+zip'},blob:async()=>new Blob([bytes],{type:'application/epub+zip'})};}
}
function env(db,bucket){return{DB:db,FILES:bucket,TELEGRAM_BOT_TOKEN:TOKEN,ADMIN_TELEGRAM_IDS:'424242',BOT_USERNAME:'domnekromanta_bot'};}

async function publishRequest(cookie,origin=ORIGIN){return new Request(`${ORIGIN}/api/admin/publications/7/publish`,{method:'POST',headers:{cookie,origin}});}

async function withTelegramMock(fn){
  const original=globalThis.fetch;const calls=[];
  globalThis.fetch=async(url,options={})=>{
    calls.push({url:String(url),options});const method=String(url).split('/').pop();
    if(method==='sendDocument')return new Response(JSON.stringify({ok:true,result:{message_id:101,document:{file_id:'telegram-prewarmed-file'}}}),{headers:{'content-type':'application/json'}});
    if(method==='deleteMessage')return new Response(JSON.stringify({ok:true,result:true}),{headers:{'content-type':'application/json'}});
    throw new Error(`Unexpected Telegram method ${method}`);
  };
  try{return await fn(calls);}finally{globalThis.fetch=original;}
}

test('prewarm rejects cross-origin publish before D1, R2 or Telegram side effects',async()=>{
  const db=new MockDB();const bucket=new MockBucket();const cookie=await adminCookie();
  await withTelegramMock(async(calls)=>{
    const response=await handlePublicationFileCachePrewarm(await publishRequest(cookie,'https://evil.example'),env(db,bucket));
    assert.ok(response);assert.equal(response.status,403);assert.equal(db.reads.length,0);assert.equal(db.operations.length,0);assert.equal(bucket.gets.length,0);assert.equal(calls.length,0);
  });
});

test('publish prewarm uploads a cold R2 asset once, stores file_id and removes the temporary admin message',async()=>{
  const db=new MockDB();const bucket=new MockBucket();const cookie=await adminCookie();
  await withTelegramMock(async(calls)=>{
    const response=await handlePublicationFileCachePrewarm(await publishRequest(cookie),env(db,bucket));
    assert.equal(response,null);
    assert.equal(db.asset.telegram_file_id,'telegram-prewarmed-file');
    assert.deepEqual(bucket.gets,['publications/7/files/chapter.epub']);
    assert.equal(calls.filter((call)=>call.url.endsWith('/sendDocument')).length,1);
    assert.equal(calls.filter((call)=>call.url.endsWith('/deleteMessage')).length,1);
    assert.ok(db.operations.some((row)=>row.query.startsWith('INSERT INTO publication_asset_cache_locks')));
    assert.ok(db.operations.some((row)=>row.query.includes("'telegram_cache_prewarmed'" )||row.values.includes('telegram_cache_prewarmed')));
  });
});
