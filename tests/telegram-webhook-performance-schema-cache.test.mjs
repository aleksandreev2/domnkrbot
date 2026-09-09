import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureTelegramNotificationSettingsSchema } from '../dist-runtime/telegram-notification-settings.js';
import { ensureTelegramTextBotUxSchema } from '../dist-runtime/telegram-text-bot-ux-schema.js';
import { handleChannelMembershipAppealWebhook } from '../dist-runtime/channel-membership-appeals.js';

const normalize=(value)=>String(value).replace(/\s+/g,' ').trim();

class SchemaStatement{
  constructor(db,query){this.db=db;this.query=normalize(query);this.values=[];}
  bind(...values){this.values=values;return this;}
  async first(){return null;}
  async all(){return{results:[]};}
  async run(){
    this.db.queries.push(this.query);
    if(this.db.failNext){
      this.db.failNext=false;
      throw new Error('temporary D1 failure');
    }
    return{meta:{changes:0}};
  }
}
class SchemaDB{
  constructor(){this.queries=[];this.failNext=false;}
  prepare(query){return new SchemaStatement(this,query);}
}

function countMatching(db,pattern){return db.queries.filter((query)=>pattern.test(query)).length;}

test('notification settings schema repair is cached per DB binding and retries after failure',async()=>{
  const db=new SchemaDB();
  await ensureTelegramNotificationSettingsSchema({DB:db});
  const afterFirst=db.queries.length;
  assert.ok(afterFirst>0);
  await ensureTelegramNotificationSettingsSchema({DB:db});
  assert.equal(db.queries.length,afterFirst,'second successful ensure must execute no additional DDL');

  const other=new SchemaDB();
  await ensureTelegramNotificationSettingsSchema({DB:other});
  assert.ok(other.queries.length>0,'a distinct DB binding must initialize independently');

  const flaky=new SchemaDB();
  flaky.failNext=true;
  await assert.rejects(()=>ensureTelegramNotificationSettingsSchema({DB:flaky}),/temporary D1 failure/);
  const failedCount=flaky.queries.length;
  await assert.doesNotReject(()=>ensureTelegramNotificationSettingsSchema({DB:flaky}));
  assert.ok(flaky.queries.length>failedCount,'failed initialization must not poison the cache');
});

test('text-bot UX schema repair is cached per DB binding',async()=>{
  const db=new SchemaDB();
  await ensureTelegramTextBotUxSchema({DB:db});
  const afterFirst=db.queries.length;
  assert.ok(countMatching(db,/ALTER TABLE telegram_proposal_sessions/i)>=2);
  await ensureTelegramTextBotUxSchema({DB:db});
  assert.equal(db.queries.length,afterFirst,'warm ensure must execute no additional UX DDL');

  const other=new SchemaDB();
  await ensureTelegramTextBotUxSchema({DB:other});
  assert.ok(other.queries.length>0,'a distinct DB binding must initialize independently');
});

class AppealStatement{
  constructor(db,query){this.db=db;this.query=normalize(query);this.values=[];}
  bind(...values){this.values=values;return this;}
  async first(){
    if(this.query.includes('FROM channel_access_state WHERE user_telegram_id=?'))return null;
    if(this.query.includes('SELECT value FROM app_settings'))return null;
    return null;
  }
  async all(){return{results:[]};}
  async run(){this.db.queries.push(this.query);return{meta:{changes:0}};}
}
class AppealDB{
  constructor(){this.queries=[];}
  prepare(query){return new AppealStatement(this,query);}
}
function appealRequest(){
  return new Request('https://domnkr.test/telegram/webhook',{
    method:'POST',
    headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'secret'},
    body:JSON.stringify({callback_query:{id:'cb-1',from:{id:42,first_name:'Reader'},data:'membership:appeal',message:{message_id:1,chat:{id:42,type:'private'}}}}),
  });
}

test('membership appeal schema repair runs once on a warm DB binding',async()=>{
  const db=new AppealDB();
  const env={DB:db,TELEGRAM_BOT_TOKEN:'token',TELEGRAM_WEBHOOK_SECRET:'secret',ADMIN_TELEGRAM_IDS:'777'};
  const original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({ok:true,result:true});
  try{
    await handleChannelMembershipAppealWebhook(appealRequest(),env,{waitUntil(){}});
    const afterFirst=countMatching(db,/CREATE TABLE IF NOT EXISTS channel_membership_appeals/i);
    assert.equal(afterFirst,1);
    await handleChannelMembershipAppealWebhook(appealRequest(),env,{waitUntil(){}});
    assert.equal(
      countMatching(db,/CREATE TABLE IF NOT EXISTS channel_membership_appeals/i),
      afterFirst,
      'warm appeal lookup must not rerun appeal DDL',
    );
  }finally{globalThis.fetch=original;}
});
