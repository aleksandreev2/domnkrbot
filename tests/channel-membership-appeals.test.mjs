import assert from 'node:assert/strict';
import test from 'node:test';
import { handleChannelMembershipAppealWebhook } from '../dist-runtime/channel-membership-appeals.js';

const ORIGIN='https://domnkr.test';
const now=()=>new Date().toISOString();

class Statement{
  constructor(db,query){this.db=db;this.query=query.replace(/\s+/g,' ').trim();this.values=[];}
  bind(...values){this.values=values;return this;}
  async first(){
    const q=this.query;
    if(q.includes('SELECT value FROM app_settings'))return this.values[0]==='publish_channel_id'?{value:'@domnekromanta'}:null;
    if(q.includes('FROM channel_access_state WHERE user_telegram_id=?'))return this.db.access.get(String(this.values[0]))||null;
    if(q.includes('FROM channel_telegram_bans WHERE user_telegram_id=?'))return this.db.bans.get(String(this.values[0]))||null;
    if(q.includes('FROM channel_membership_appeals')&&q.includes("status IN ('draft','pending')")&&q.includes('user_telegram_id=?')){
      const userId=String(this.values[0]);
      return [...this.db.appeals.values()].find((row)=>row.user_telegram_id===userId&&['draft','pending'].includes(row.status))||null;
    }
    if(q.includes('FROM channel_membership_appeals')&&q.includes('WHERE id=?'))return this.db.appeals.get(String(this.values[0]))||null;
    return null;
  }
  async all(){return{results:[]};}
  async run(){
    this.db.runs.push({query:this.query,values:[...this.values]});
    const q=this.query;
    if(q.startsWith('INSERT INTO channel_membership_appeals')){
      const [id,userId]=this.values;
      this.db.appeals.set(String(id),{id:String(id),user_telegram_id:String(userId),status:'draft',user_comment:'',admin_comment:null,created_at:now(),submitted_at:null,resolved_at:null,resolved_by:null});
      return{};
    }
    if(q.startsWith("UPDATE channel_membership_appeals SET status='pending'")){
      const [comment,id]=this.values;const row=this.db.appeals.get(String(id));
      if(row)this.db.appeals.set(String(id),{...row,status:'pending',user_comment:String(comment),submitted_at:now()});
      return{};
    }
    if(q.startsWith("UPDATE channel_membership_appeals SET status='approved'")){
      const [adminComment,resolvedBy,id]=this.values;const row=this.db.appeals.get(String(id));
      if(row)this.db.appeals.set(String(id),{...row,status:'approved',admin_comment:String(adminComment||''),resolved_by:String(resolvedBy),resolved_at:now()});
      return{};
    }
    if(q.startsWith('UPDATE channel_access_state SET blacklisted_at=NULL')){
      const id=String(this.values[0]);const row=this.db.access.get(id)||{};
      this.db.access.set(id,{...row,blacklisted_at:null,blacklist_reason:null,left_at:null,last_status:'manual_unblock'});
      return{};
    }
    if(q.startsWith('DELETE FROM channel_telegram_bans')){this.db.bans.delete(String(this.values[0]));return{};}
    if(q.startsWith('INSERT INTO channel_telegram_bans')){
      const id=String(this.values[0]);this.db.bans.set(id,{user_telegram_id:id,banned_at:now(),last_attempt_at:now(),last_error:null});return{};
    }
    return{};
  }
}
class DB{
  constructor(){this.access=new Map();this.bans=new Map();this.appeals=new Map();this.runs=[];}
  prepare(query){return new Statement(this,query);}
}
function environment(db){return{DB:db,TELEGRAM_BOT_TOKEN:'token',TELEGRAM_WEBHOOK_SECRET:'secret',PUBLISH_CHANNEL_ID:'@domnekromanta',BOT_USERNAME:'domnekromanta_bot',ADMIN_TELEGRAM_IDS:'777'};}
function blacklisted(){return{user_telegram_id:'42',last_status:'left',last_checked_at:now(),left_at:now(),rejoined_at:null,blacklisted_at:now(),blacklist_reason:'left_channel'};}
function webhook(update){return new Request(`${ORIGIN}/telegram/webhook`,{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'secret'},body:JSON.stringify(update)});}
function callback(data,fromId=42){return webhook({callback_query:{id:`cb-${data}`,from:{id:fromId,first_name:fromId===777?'Admin':'Reader',username:fromId===777?'admin':'reader42'},data,message:{message_id:5,chat:{id:fromId,type:'private'}}}});}
function message(text,fromId=42){return webhook({message:{message_id:6,chat:{id:fromId,type:'private'},from:{id:fromId,first_name:fromId===777?'Admin':'Reader',username:fromId===777?'admin':'reader42'},text}});}
async function withTelegram(fn){
  const original=globalThis.fetch;const calls=[];
  globalThis.fetch=async(url,options={})=>{
    const method=String(url).split('/').pop();const payload=JSON.parse(String(options.body||'{}'));
    calls.push({method,payload});
    return Response.json({ok:true,result:true});
  };
  try{return await fn(calls);}finally{globalThis.fetch=original;}
}

test('appeal webhook fails closed when Telegram secret is missing',async()=>{
  const db=new DB();db.access.set('42',blacklisted());
  const env=environment(db);delete env.TELEGRAM_WEBHOOK_SECRET;
  await withTelegram(async(calls)=>{
    const response=await handleChannelMembershipAppealWebhook(callback('membership:appeal'),env,{waitUntil(){}});
    assert.equal(response,null);
    assert.equal(calls.length,0);
    assert.equal(db.runs.length,0);
  });
});

test('blacklisted download message offers an appeal action before reader delivery',async()=>{
  const db=new DB();db.access.set('42',blacklisted());
  await withTelegram(async(calls)=>{
    const response=await handleChannelMembershipAppealWebhook(message('/start dl_7'),environment(db),{waitUntil(){}});
    assert.equal(response?.status,200);
    const sent=calls.find((call)=>call.method==='sendMessage'&&call.payload.chat_id===42);
    assert.ok(sent);
    const buttons=sent.payload.reply_markup?.inline_keyboard?.flat()||[];
    assert.ok(buttons.some((button)=>button.callback_data==='membership:appeal'));
  });
});

test('blacklisted user submits an appeal comment and configured admin is notified',async()=>{
  const db=new DB();db.access.set('42',blacklisted());
  await withTelegram(async(calls)=>{
    const started=await handleChannelMembershipAppealWebhook(callback('membership:appeal'),environment(db),{waitUntil(){}});
    assert.equal(started?.status,200);
    const draft=[...db.appeals.values()][0];
    assert.ok(draft);assert.equal(draft.status,'draft');

    const submitted=await handleChannelMembershipAppealWebhook(message('Я не выходил специально, проверьте пожалуйста.'),environment(db),{waitUntil(){}});
    assert.equal(submitted?.status,200);
    assert.equal(db.appeals.get(draft.id)?.status,'pending');
    assert.match(db.appeals.get(draft.id)?.user_comment||'',/не выходил/);
    const adminNotice=calls.find((call)=>call.method==='sendMessage'&&call.payload.chat_id===777);
    assert.ok(adminNotice,'expected appeal notification for configured admin');
    assert.match(adminNotice.payload.text,/апелляц/i);
    assert.match(adminNotice.payload.text,/не выходил/i);
    const buttons=adminNotice.payload.reply_markup?.inline_keyboard?.flat()||[];
    assert.ok(buttons.some((button)=>button.callback_data===`membership:appeal:approve:${draft.id}`));
  });
});

test('admin approval unbans user, clears internal blacklist and notifies the appellant',async()=>{
  const db=new DB();db.access.set('42',blacklisted());db.bans.set('42',{user_telegram_id:'42',banned_at:now(),last_attempt_at:now(),last_error:null});
  db.appeals.set('appeal-1',{id:'appeal-1',user_telegram_id:'42',status:'pending',user_comment:'Ошибка',admin_comment:null,created_at:now(),submitted_at:now(),resolved_at:null,resolved_by:null});
  await withTelegram(async(calls)=>{
    const response=await handleChannelMembershipAppealWebhook(callback('membership:appeal:approve:appeal-1',777),environment(db),{waitUntil(){}});
    assert.equal(response?.status,200);
    assert.equal(db.appeals.get('appeal-1')?.status,'approved');
    assert.equal(db.access.get('42')?.blacklisted_at,null);
    assert.ok(calls.some((call)=>call.method==='unbanChatMember'&&call.payload.user_id===42));
    const userNotice=calls.find((call)=>call.method==='sendMessage'&&call.payload.chat_id===42);
    assert.ok(userNotice);assert.match(userNotice.payload.text,/одобрен|снят/i);
  });
});
