import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { handleWebAuth } from '../dist-runtime/web-auth.js';
import { handlePublicationLifecycleApi } from '../dist-runtime/publication-lifecycle.js';
import { handlePublicationArchiveGuard } from '../dist-runtime/publication-archive-guard.js';

const TOKEN='123456:test-token-for-unit-tests-only';
const ORIGIN='https://domnkr.test';

function telegramLoginUrl(){
  const fields={id:'424242',first_name:'Necromancer',username:'domnkr_test',auth_date:String(Math.floor(Date.now()/1000))};
  const dataCheckString=Object.entries(fields).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>`${key}=${value}`).join('\n');
  const secret=createHash('sha256').update(TOKEN).digest();
  const hash=createHmac('sha256',secret).update(dataCheckString).digest('hex');
  const url=new URL('/auth/telegram/callback',ORIGIN);
  for(const [key,value] of Object.entries(fields))url.searchParams.set(key,value);
  url.searchParams.set('hash',hash);
  return url;
}

async function adminCookie(){
  const response=await handleWebAuth(new Request(telegramLoginUrl()),{TELEGRAM_BOT_TOKEN:TOKEN,ADMIN_TELEGRAM_IDS:'424242',BOT_USERNAME:'domnekromanta_bot'});
  assert.ok(response);
  const raw=response.headers.get('set-cookie');
  assert.ok(raw);
  return raw.split(';',1)[0];
}

class MockStatement{
  constructor(db,query){this.db=db;this.query=query.replace(/\s+/g,' ').trim();this.values=[];}
  bind(...values){this.values=values;return this;}
  async first(){
    if(this.query.includes('SELECT id,status,body_html,add_footer,image_key,channel_message_id FROM publications'))return {...this.db.publication};
    if(this.query==='SELECT status FROM publications WHERE id=?')return {status:this.db.publication.status};
    if(this.query==='SELECT value FROM app_settings WHERE key=?')return this.db.settings[this.values[0]]!==undefined?{value:this.db.settings[this.values[0]]}:null;
    if(this.query==='SELECT COUNT(*) AS count FROM publication_assets WHERE publication_id=?')return {count:this.db.assetCount};
    return null;
  }
  async run(){
    this.db.operations.push({query:this.query,values:[...this.values]});
    if(this.query.startsWith('UPDATE publications SET body_html='))this.db.publication.body_html=String(this.values[0]);
    if(this.query.includes("UPDATE publications SET status='deleted'"))this.db.publication.status='deleted';
    return {};
  }
}

class MockDB{
  constructor(status='published'){
    this.publication={id:7,status,body_html:'Старый текст',add_footer:1,image_key:null,channel_message_id:777};
    this.settings={publish_channel_id:'@domnkr_channel'};
    this.assetCount=1;
    this.operations=[];
  }
  prepare(query){return new MockStatement(this,query);}
}

function env(db){return{DB:db,TELEGRAM_BOT_TOKEN:TOKEN,ADMIN_TELEGRAM_IDS:'424242',BOT_USERNAME:'domnekromanta_bot'};}

async function adminRequest(path,{method='POST',body}={}){
  return new Request(`${ORIGIN}${path}`,{
    method,
    headers:{origin:ORIGIN,cookie:await adminCookie(),...(body?{'content-type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined,
  });
}

test('published edit updates Telegram first and then persists D1 body',async(t)=>{
  const db=new MockDB();
  const calls=[];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{calls.push({url:String(url),payload:JSON.parse(options.body)});return new Response(JSON.stringify({ok:true,result:{message_id:777}}),{headers:{'content-type':'application/json'}});};
  t.after(()=>{globalThis.fetch=originalFetch;});

  const response=await handlePublicationLifecycleApi(await adminRequest('/api/admin/publications/7/edit',{body:{body:'Новый текст'}}),env(db));
  assert.ok(response);
  assert.equal(response.status,200);
  assert.equal(db.publication.body_html,'Новый текст');
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/\/editMessageText$/);
  assert.equal(calls[0].payload.message_id,777);
  assert.match(calls[0].payload.text,/Новый текст/);
  assert.match(calls[0].payload.text,/Файлы находятся в комментариях/);
  assert.match(calls[0].payload.text,/t\.me\/domnekromanta_bot/);
  const telegramIndex=db.operations.findIndex((entry)=>entry.query.startsWith('UPDATE publications SET body_html='));
  assert.ok(telegramIndex>=0,'D1 body update must happen after Telegram success');
});

test('failed Telegram edit does not persist the new body',async(t)=>{
  const db=new MockDB();
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({ok:false,error_code:400,description:"Bad Request: message can't be edited"}),{status:400,headers:{'content-type':'application/json'}});
  t.after(()=>{globalThis.fetch=originalFetch;});

  const response=await handlePublicationLifecycleApi(await adminRequest('/api/admin/publications/7/edit',{body:{body:'Не должно сохраниться'}}),env(db));
  assert.ok(response);
  assert.equal(response.status,502);
  assert.equal(db.publication.body_html,'Старый текст');
  assert.equal(db.operations.some((entry)=>entry.query.startsWith('UPDATE publications SET body_html=')),false);
});

test('delete from Telegram archives the publication while retaining its record',async(t)=>{
  const db=new MockDB();
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({ok:true,result:true}),{headers:{'content-type':'application/json'}});
  t.after(()=>{globalThis.fetch=originalFetch;});

  const response=await handlePublicationLifecycleApi(await adminRequest('/api/admin/publications/7/delete-telegram'),env(db));
  assert.ok(response);
  assert.equal(response.status,200);
  assert.equal(db.publication.status,'deleted');
  assert.equal(db.publication.body_html,'Старый текст');
  assert.equal(db.operations.some((entry)=>entry.query.startsWith('DELETE FROM publications')),false);
});

test('already deleted Telegram message is reconciled into archive state',async(t)=>{
  const db=new MockDB();
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({ok:false,error_code:400,description:'Bad Request: message to delete not found'}),{status:400,headers:{'content-type':'application/json'}});
  t.after(()=>{globalThis.fetch=originalFetch;});

  const response=await handlePublicationLifecycleApi(await adminRequest('/api/admin/publications/7/delete-telegram'),env(db));
  assert.ok(response);
  assert.equal(response.status,200);
  assert.equal(db.publication.status,'deleted');
  const body=await response.json();
  assert.equal(body.alreadyMissing,true);
});

test('archived publication cannot be republished or deleted as a draft',async()=>{
  const db=new MockDB('deleted');
  const publish=await handlePublicationArchiveGuard(await adminRequest('/api/admin/publications/7/publish'),env(db));
  assert.ok(publish);
  assert.equal(publish.status,409);
  const remove=await handlePublicationArchiveGuard(await adminRequest('/api/admin/publications/7',{method:'DELETE'}),env(db));
  assert.ok(remove);
  assert.equal(remove.status,409);
});
