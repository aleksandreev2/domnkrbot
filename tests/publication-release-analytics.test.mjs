import assert from 'node:assert/strict';
import test from 'node:test';
import { handlePublicationReleaseAnalytics, parsePositiveId } from '../dist-runtime/publication-release-analytics.js';

const ORIGIN='https://domnkr.test';

class NoTouchDB{
  constructor(){this.calls=0;}
  prepare(){this.calls+=1;throw new Error('D1 must not be touched');}
  batch(){this.calls+=1;throw new Error('D1 must not be touched');}
}

test('release analytics id parser accepts only positive safe integers',()=>{
  assert.equal(parsePositiveId('1'),1);
  assert.equal(parsePositiveId('42'),42);
  assert.equal(parsePositiveId('0'),null);
  assert.equal(parsePositiveId('-1'),null);
  assert.equal(parsePositiveId('1.5'),null);
  assert.equal(parsePositiveId('abc'),null);
  assert.equal(parsePositiveId(null),null);
});

test('release analytics rejects unauthenticated access before D1',async()=>{
  const db=new NoTouchDB();
  const response=await handlePublicationReleaseAnalytics(new Request(`${ORIGIN}/api/admin/publishing-analytics/release?publication_id=7`),{
    DB:db,
    TELEGRAM_BOT_TOKEN:'123:test',
    ADMIN_TELEGRAM_IDS:'424242',
    BOT_USERNAME:'domnekromanta_bot',
  });
  assert.ok(response);
  assert.equal(response.status,401);
  assert.equal(db.calls,0);
});
