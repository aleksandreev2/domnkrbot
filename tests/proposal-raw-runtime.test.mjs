import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { handleWebAuth } from '../dist-runtime/web-auth.js';
import { handleProposalRawApi, proposalRawLimits } from '../dist-runtime/proposal-raw-runtime.js';

const TOKEN='123456:test-token-for-raw-tests';
const ORIGIN='https://domnkr.test';

function loginUrl(){
  const fields={id:'424242',first_name:'Raw',username:'raw_user',auth_date:String(Math.floor(Date.now()/1000))};
  const dataCheckString=Object.entries(fields).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>`${key}=${value}`).join('\n');
  const secret=createHash('sha256').update(TOKEN).digest();
  const hash=createHmac('sha256',secret).update(dataCheckString).digest('hex');
  const url=new URL('/auth/telegram/callback',ORIGIN);for(const [key,value] of Object.entries(fields))url.searchParams.set(key,value);url.searchParams.set('hash',hash);return url;
}

async function cookie(){
  const response=await handleWebAuth(new Request(loginUrl()),{TELEGRAM_BOT_TOKEN:TOKEN,BOT_USERNAME:'domnekromanta_bot'});
  return response.headers.get('set-cookie').split(';',1)[0];
}

class Statement{
  constructor(db,query){this.db=db;this.query=query;this.values=[];}
  bind(...values){this.values=values;return this;}
  async run(){this.db.runs.push({query:this.query,values:this.values});return{};}
  async first(){return null;}
  async all(){return{results:[]};}
}
class DB{constructor(){this.runs=[];}prepare(query){return new Statement(this,query);}}

function env(){
  return{
    DB:new DB(),
    TELEGRAM_BOT_TOKEN:TOKEN,
    BOT_USERNAME:'domnekromanta_bot',
    FILES:{
      async createMultipartUpload(key){return{uploadId:`upload:${key}`};},
      resumeMultipartUpload(){return{async uploadPart(partNumber){return{partNumber,etag:`etag-${partNumber}`};},async complete(){return{size:0,etag:'done'};},async abort(){}};},
      async head(){return null;},async get(){return null;},async delete(){},
    },
  };
}

async function request(path,{method='POST',body,withCookie=true,origin=ORIGIN}={}){
  const headers={origin};if(withCookie)headers.cookie=await cookie();if(body!==undefined)headers['content-type']='application/json';
  return new Request(`${ORIGIN}${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
}

test('RAW upload requires an authenticated website session',async()=>{
  const response=await handleProposalRawApi(await request('/api/proposal-raw/init',{withCookie:false,body:{filename:'raw.zip',size:1024}}),env());
  assert.ok(response);assert.equal(response.status,401);
});

test('RAW upload rejects cross-origin mutations',async()=>{
  const response=await handleProposalRawApi(await request('/api/proposal-raw/init',{origin:'https://evil.example',body:{filename:'raw.zip',size:1024}}),env());
  assert.ok(response);assert.equal(response.status,403);
});

test('RAW upload enforces product size and file extension limits before R2 write',async()=>{
  const tooLarge=await handleProposalRawApi(await request('/api/proposal-raw/init',{body:{filename:'raw.zip',size:proposalRawLimits.maxRawBytes+1}}),env());
  assert.equal(tooLarge.status,413);
  const badType=await handleProposalRawApi(await request('/api/proposal-raw/init',{body:{filename:'raw.exe',size:1024}}),env());
  assert.equal(badType.status,415);
});

test('valid RAW init creates a server-generated multipart intent',async()=>{
  const testEnv=env();
  const response=await handleProposalRawApi(await request('/api/proposal-raw/init',{body:{filename:'novel.zip',size:proposalRawLimits.partSize*2,contentType:'application/zip'}}),testEnv);
  assert.equal(response.status,201);const body=await response.json();assert.equal(body.partSize,proposalRawLimits.partSize);assert.equal(body.partCount,2);assert.ok(body.id);
  const insert=testEnv.DB.runs.find((entry)=>entry.query.includes('INSERT INTO proposal_raw_uploads'));
  assert.ok(insert);assert.match(String(insert.values[2]),/^proposal-raw\/424242\/.+\/source\.zip$/);assert.notEqual(insert.values[2],'novel.zip');
});

test('title proposal requires either ready RAW upload or an HTTP source URL',async()=>{
  const response=await handleProposalRawApi(await request('/api/title-proposals',{body:{title:'Новый тайтл',originalTitle:'Example',sourceUrl:'',extraUrl:'',comment:''}}),env());
  assert.equal(response.status,400);assert.match((await response.json()).error,/RAW/i);
});
