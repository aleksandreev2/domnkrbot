import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkDownloadMembership,
  handleChannelMembershipWebhook,
  runChannelMembershipMaintenance,
} from '../dist-runtime/channel-membership-access.js';

const ORIGIN='https://domnkr.test';
const now=()=>new Date().toISOString();

class MockStatement{
  constructor(db,query){this.db=db;this.query=query.replace(/\s+/g,' ').trim();this.values=[];}
  bind(...values){this.values=values;return this;}
  async first(){
    if(this.query.includes('SELECT value FROM app_settings'))return this.values[0]==='publish_channel_id'?{value:'@domnekromanta'}:null;
    if(this.query.includes('FROM channel_access_state WHERE user_telegram_id=?'))return this.db.access.get(String(this.values[0]))||null;
    return null;
  }
  async all(){
    if(this.query.includes('FROM channel_access_state')&&this.query.includes("last_status IN ('creator','administrator','member','restricted')")){
      const limit=Number(this.values[0]||40);
      const rows=[...this.db.access.values()]
        .filter((row)=>!row.blacklisted_at&&['creator','administrator','member','restricted'].includes(row.last_status))
        .sort((a,b)=>String(a.last_checked_at||'').localeCompare(String(b.last_checked_at||'')))
        .slice(0,limit);
      return{results:rows};
    }
    return{results:[]};
  }
  async run(){
    this.db.operations.push({query:this.query,values:[...this.values]});
    if(this.query.startsWith('INSERT INTO channel_access_state')&&this.query.includes('VALUES (?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?,CURRENT_TIMESTAMP)')){
      const [id,status,reason]=this.values;const previous=this.db.access.get(String(id))||{};
      this.db.access.set(String(id),{...previous,user_telegram_id:String(id),last_status:String(status),last_checked_at:now(),left_at:previous.left_at||now(),rejoined_at:previous.rejoined_at||null,blacklisted_at:previous.blacklisted_at||now(),blacklist_reason:previous.blacklist_reason||String(reason)});
      return{};
    }
    if(this.query.startsWith('INSERT INTO channel_access_state')){
      const [id,status,lastChecked,leftAt,rejoinedAt,blacklistedAt,reason]=this.values;const previous=this.db.access.get(String(id))||{};
      this.db.access.set(String(id),{user_telegram_id:String(id),last_status:String(status),last_checked_at:lastChecked,left_at:leftAt,rejoined_at:rejoinedAt,blacklisted_at:previous.blacklisted_at||blacklistedAt||null,blacklist_reason:previous.blacklist_reason||reason||null});
      return{};
    }
    return{};
  }
}
class MockDB{
  constructor(){this.access=new Map();this.operations=[];}
  prepare(query){return new MockStatement(this,query);}
}

function env(db){return{DB:db,TELEGRAM_BOT_TOKEN:'unit-test-token',BOT_USERNAME:'domnekromanta_bot',PUBLISH_CHANNEL_ID:'@domnekromanta',TELEGRAM_WEBHOOK_SECRET:'unit-test-secret'};}
function access(status='member',overrides={}){
  return{user_telegram_id:'42',last_status:status,last_checked_at:now(),left_at:null,rejoined_at:null,blacklisted_at:null,blacklist_reason:null,...overrides};
}
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
function memberUpdate(oldStatus,newStatus){
  return new Request(`${ORIGIN}/telegram/webhook`,{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'unit-test-secret'},body:JSON.stringify({chat_member:{chat:{id:-100123,type:'channel',username:'domnekromanta'},from:{id:42},date:1,old_chat_member:{status:oldStatus,user:{id:42}},new_chat_member:{status:newStatus,user:{id:42}}}})});
}

test('reader who was never confirmed as a member is asked to subscribe and is not blacklisted',async()=>{
  const db=new MockDB();
  await withTelegramStatus('left',async(calls)=>{
    const allowed=await checkDownloadMembership(env(db),{id:42,first_name:'Reader'},7);
    assert.equal(allowed,false);
    const prompt=calls.find((call)=>call.url.endsWith('/sendMessage'));
    assert.ok(prompt);assert.match(String(prompt.options.body),/Подписаться на канал/);
  });
  assert.equal(db.access.get('42')?.blacklisted_at,null);
});

test('missed leave is detected on the next membership check even without any download',async()=>{
  const db=new MockDB();db.access.set('42',access('member'));
  await withTelegramStatus('left',async(calls)=>{
    const allowed=await checkDownloadMembership(env(db),{id:42,first_name:'Reader'},7);
    assert.equal(allowed,false);
    assert.ok(calls.some((call)=>call.url.endsWith('/getChatMember')));
  });
  assert.ok(db.access.get('42')?.blacklisted_at);
  assert.equal(db.access.get('42')?.blacklist_reason,'left_channel');
});

test('chat_member member-to-left transition blacklists immediately without a download',async()=>{
  const db=new MockDB();
  await withTelegramStatus('left',async()=>{
    const response=await handleChannelMembershipWebhook(memberUpdate('member','left'),env(db),{waitUntil(){}});
    assert.ok(response);assert.equal(response.status,200);
  });
  assert.ok(db.access.get('42')?.blacklisted_at);
  assert.equal(db.access.get('42')?.blacklist_reason,'left_channel');
});

test('nonmember status churn does not blacklist someone who was never confirmed as a member',async()=>{
  const db=new MockDB();
  await withTelegramStatus('left',async()=>{
    const response=await handleChannelMembershipWebhook(memberUpdate('left','kicked'),env(db),{waitUntil(){}});
    assert.ok(response);assert.equal(response.status,200);
  });
  assert.equal(db.access.get('42')?.blacklisted_at,null);
  assert.equal(db.access.get('42')?.last_status,'kicked');
});

test('maintenance catches a missed leave for any known member without requiring a download',async()=>{
  const db=new MockDB();db.access.set('42',access('member',{last_checked_at:null}));
  await withTelegramStatus('left',async()=>{
    const result=await runChannelMembershipMaintenance(env(db));
    assert.equal(result.checked,1);assert.equal(result.blacklisted,1);assert.equal(result.members,0);
  });
  assert.ok(db.access.get('42')?.blacklisted_at);
  assert.equal(db.access.get('42')?.blacklist_reason,'left_channel');
});

test('Telegram verification failure never blacklists a known member',async()=>{
  const db=new MockDB();db.access.set('42',access('member',{last_checked_at:null}));
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({ok:false,description:'temporary failure'}),{status:500,headers:{'content-type':'application/json'}});
  try{
    const result=await runChannelMembershipMaintenance(env(db));
    assert.equal(result.checked,1);assert.equal(result.blacklisted,0);
    assert.equal(db.access.get('42')?.blacklisted_at,null);
  }finally{globalThis.fetch=original;}
});

test('blacklist is not removed automatically after rejoining',async()=>{
  const db=new MockDB();db.access.set('42',access('left',{left_at:now(),blacklisted_at:now(),blacklist_reason:'left_channel'}));
  await withTelegramStatus('member',async(calls)=>{
    const allowed=await checkDownloadMembership(env(db),{id:42,first_name:'Reader'},7);
    assert.equal(allowed,false);
    assert.equal(calls.some((call)=>call.url.endsWith('/getChatMember')),false);
  });
  assert.ok(db.access.get('42')?.blacklisted_at);
});
