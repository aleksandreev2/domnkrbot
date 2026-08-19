import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { handleWebAuth } from '../dist-runtime/web-auth.js';
import {
  handleAdminUserWorkspace,
  normalizeAdminTags,
  parseUserListOptions,
} from '../dist-runtime/admin-user-workspace.js';

const TOKEN='123456:test-token-for-admin-user-workspace';
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
  const raw=response.headers.get('set-cookie');assert.ok(raw);
  return raw.split(';',1)[0];
}

class MockStatement{
  constructor(db,query){this.db=db;this.query=query.replace(/\s+/g,' ').trim();this.values=[];}
  bind(...values){this.values=values;return this;}
  async first(){
    if(this.query==='SELECT telegram_id FROM users WHERE telegram_id=?')return this.db.userExists?{telegram_id:String(this.values[0])}:null;
    return null;
  }
  async all(){return{results:[]};}
  async run(){this.db.runs.push({query:this.query,values:[...this.values]});return{};}
}
class MockDB{
  constructor({userExists=true}={}){this.userExists=userExists;this.runs=[];this.prepareCalls=0;}
  prepare(query){this.prepareCalls+=1;return new MockStatement(this,query);}
}
function env(db){return{DB:db,TELEGRAM_BOT_TOKEN:TOKEN,ADMIN_TELEGRAM_IDS:'424242',BOT_USERNAME:'domnekromanta_bot'};}

function adminRequest(path,{method='GET',origin=ORIGIN,body}={}){
  return adminCookie().then((cookie)=>new Request(`${ORIGIN}${path}`,{
    method,
    headers:{cookie,origin,'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  }));
}

test('admin user list rejects unauthenticated access before touching D1',async()=>{
  const db=new MockDB();
  const response=await handleAdminUserWorkspace(new Request(`${ORIGIN}/api/admin/users`),env(db));
  assert.ok(response);assert.equal(response.status,401);assert.equal(db.prepareCalls,0);
});

test('user list options clamp unsupported filter, sort, offset and page size',()=>{
  const url=new URL(`${ORIGIN}/api/admin/users?q=${'x'.repeat(140)}&filter=nope&sort=nope&offset=-9&limit=999`);
  const options=parseUserListOptions(url);
  assert.equal(options.q.length,100);
  assert.equal(options.filter,'all');
  assert.equal(options.sort,'recent');
  assert.equal(options.offset,0);
  assert.equal(options.limit,50);
});

test('admin tags are normalized, deduplicated and bounded',()=>{
  const tags=normalizeAdminTags([' #Trusted ','trusted','Translator','','problematic','#Problematic',...Array.from({length:20},(_,i)=>`tag-${i}`)]);
  assert.deepEqual(tags.slice(0,3),['Trusted','Translator','problematic']);
  assert.equal(tags.length,12);
});

test('cross-origin user message is rejected before schema or Telegram calls',async(t)=>{
  const db=new MockDB();let telegramCalls=0;const original=globalThis.fetch;globalThis.fetch=async()=>{telegramCalls+=1;throw new Error('must not call Telegram');};t.after(()=>{globalThis.fetch=original;});
  const response=await handleAdminUserWorkspace(await adminRequest('/api/admin/users/42/message',{method:'POST',origin:'https://evil.example',body:{text:'hello'}}),env(db));
  assert.ok(response);assert.equal(response.status,403);assert.equal(db.prepareCalls,0);assert.equal(telegramCalls,0);
});

test('failed direct Telegram message is stored and audited without exposing token',async(t)=>{
  const db=new MockDB();const original=globalThis.fetch;globalThis.fetch=async(url)=>{
    assert.match(String(url),/\/sendMessage$/);
    return new Response(JSON.stringify({ok:false,description:'bot was blocked by the user'}),{status:403,headers:{'content-type':'application/json'}});
  };t.after(()=>{globalThis.fetch=original;});
  const response=await handleAdminUserWorkspace(await adminRequest('/api/admin/users/42/message',{method:'POST',body:{text:'Проверочное сообщение'}}),env(db));
  assert.ok(response);assert.equal(response.status,502);
  const body=await response.json();assert.match(body.error,/bot was blocked by the user/);assert.doesNotMatch(body.error,/test-token/);
  assert.ok(db.runs.some((row)=>row.query.startsWith('INSERT INTO admin_user_messages')&&row.values.includes('failed')));
  assert.ok(db.runs.some((row)=>row.query.startsWith('INSERT INTO admin_audit_log')&&row.values.includes('user_message_failed')));
});
