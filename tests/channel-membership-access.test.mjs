import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkDownloadMembership,
  handleChannelMembershipWebhook,
  runChannelMembershipMaintenance,
} from '../dist-runtime/channel-membership-access.js';

const ORIGIN='https://domnkr.test';

class MockStatement{
  constructor(db,query){this.db=db;this.query=query.replace(/\s+/g,' ').trim();this.values=[];}
  bind(...values){this.values=values;return this;}
  async first(){
    if(this.query.includes('SELECT value FROM app_settings'))return this.values[0]==='publish_channel_id'?{value:'@domnekromanta'}:null;
    if(this.query.includes('FROM channel_access_state WHERE user_telegram_id=?'))return this.db.access.get(String(this.values[0]))||null;
    if(this.query.includes('SELECT 1 ok FROM publication_deliveries'))return this.db.downloaded.has(String(this.values[0]))?{ok:1}:null;
    return null;
  }
  async all(){
    if(this.query.includes('FROM channel_access_state WHERE blacklisted_at IS NULL AND left_at IS NOT NULL')){
      const cutoff=new Date(String(this.values[0])).getTime();
      return{results:[...this.db.access.values()].filter((row)=>!row.blacklisted_at&&row.left_at&&new Date(row.left_at).getTime()<=cutoff)};
    }
    return{results:[]};
  }
  async run(){
    this.db.operations.push({query:this.query,values:[...this.values]});
    if(this.query.startsWith('INSERT INTO channel_access_state')){
      const [id,status,lastChecked,leftAt,rejoinedAt,blacklistedAt,reason]=this.values;
      const previous=this.db.access.get(String(id))||{};
      this.db.access.set(String(id),{
        user_telegram_id:String(id),last_status:String(status),last_checked_at:lastChecked,left_at:leftAt,rejoined_at:rejoinedAt,
        blacklisted_at:previous.blacklisted_at||blacklistedAt||null,blacklist_reason:previous.blacklist_reason||reason||null,
      });
    }
    if(this.query.includes("blacklisted_at=CURRENT_TIMESTAMP,blacklist_reason='left_after_download_48h'")){
      const id=String(this.values.at(-1));const row=this.db.access.get(id);if(row){row.blacklisted_at=new Date().toISOString();row.blacklist_reason='left_after_download_48h';row.last_status=String(this.values[0]);}
    }
    return{};
  }
}
class MockDB{
  constructor(){this.access=new Map();this.downloaded=new Set();this.operations=[];}
  prepare(query){return new MockStatement(this,query);}
}

function env(db){return{DB:db,TELEGRAM_BOT_TOKEN:'123:test',BOT_USERNAME:'domnekromanta_bot',PUBLISH_CHANNEL_ID:'@domnekromanta',TELEGRAM_WEBHOOK_SECRET:'secret'};}
async function withTelegramStatus(status,fn){
  const original=globalThis.fetch;const calls=[];
  globalThis.fetch=async(url,options={})=>{
    calls.push({url:String(url),options});const method=String(url).split('/').pop();
    if(method==='getChatMember')return new Response(JSON.stringify({ok:true,result:{status,user:{id:42}}}),{headers:{'content-type':'application/json'}});
    if(method==='getChat')return new Response(JSON.stringify({ok:true,result:{id:-100123,username:'domnekromanta',type:'channel'}}),{headers:{'content-type':'application/json'}});
    return new Response(JSON.stringify({ok:true,result:{message_id:1}}),{headers:{'content-type':'application/json'}});
  };
  try{return await fn(calls);}finally{globalThis.fetch=original;}
}

test('download is denied until the reader is subscribed',async()=>{
  const db=new MockDB();db.downloaded.add('42');
  await withTelegramStatus('left',async(calls)=>{
    const allowed=await checkDownloadMembership(env(db),{id:42,first_name:'Reader'},7);
    assert.equal(allowed,false);
    assert.ok(calls.some((call)=>call.url.endsWith('/getChatMember')));
    const prompt=calls.find((call)=>call.url.endsWith('/sendMessage'));
    assert.ok(prompt);assert.match(String(prompt.options.body),/Подписаться на канал/);
  });
  assert.ok(db.access.get('42')?.left_at);
});

test('rejoining during grace period clears the leave timer',async()=>{
  const db=new MockDB();db.access.set('42',{user_telegram_id:'42',last_status:'left',last_checked_at:null,left_at:new Date(Date.now()-60*60_000).toISOString(),rejoined_at:null,blacklisted_at:null,blacklist_reason:null});
  await withTelegramStatus('member',async()=>{
    const allowed=await checkDownloadMembership(env(db),{id:42,first_name:'Reader'},7);
    assert.equal(allowed,true);
  });
  assert.equal(db.access.get('42')?.left_at,null);
  assert.ok(db.access.get('42')?.rejoined_at);
});

test('chat_member leave starts grace period only for a reader who already downloaded',async()=>{
  const db=new MockDB();db.downloaded.add('42');
  await withTelegramStatus('left',async()=>{
    const request=new Request(`${ORIGIN}/telegram/webhook`,{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'secret'},body:JSON.stringify({chat_member:{chat:{id:-100123,type:'channel',username:'domnekromanta'},from:{id:1},date:1,old_chat_member:{status:'member',user:{id:42}},new_chat_member:{status:'left',user:{id:42}}}})});
    const response=await handleChannelMembershipWebhook(request,env(db),{waitUntil(){}});
    assert.ok(response);assert.equal(response.status,200);
  });
  assert.ok(db.access.get('42')?.left_at);
});

test('reader still outside after 48 hours is blacklisted',async()=>{
  const db=new MockDB();db.access.set('42',{user_telegram_id:'42',last_status:'left',last_checked_at:null,left_at:new Date(Date.now()-49*60*60_000).toISOString(),rejoined_at:null,blacklisted_at:null,blacklist_reason:null});
  await withTelegramStatus('left',async()=>{
    const result=await runChannelMembershipMaintenance(env(db));
    assert.equal(result.checked,1);assert.equal(result.blacklisted,1);assert.equal(result.rejoined,0);
  });
  assert.ok(db.access.get('42')?.blacklisted_at);
  assert.equal(db.access.get('42')?.blacklist_reason,'left_after_download_48h');
});

test('Telegram verification failure never blacklists a reader',async()=>{
  const db=new MockDB();db.access.set('42',{user_telegram_id:'42',last_status:'left',last_checked_at:null,left_at:new Date(Date.now()-49*60*60_000).toISOString(),rejoined_at:null,blacklisted_at:null,blacklist_reason:null});
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({ok:false,description:'temporary failure'}),{status:500,headers:{'content-type':'application/json'}});
  try{
    const result=await runChannelMembershipMaintenance(env(db));
    assert.equal(result.checked,1);assert.equal(result.blacklisted,0);
    assert.equal(db.access.get('42')?.blacklisted_at,null);
  }finally{globalThis.fetch=original;}
});
