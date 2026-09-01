import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enqueueReleaseNotifications,
  isEffectivelySubscribed,
  setEffectiveTitleSubscription,
} from '../dist-runtime/telegram-subscriptions.js';

const normalize = (query) => query.replace(/\s+/g, ' ').trim();

class Statement {
  constructor(db, query) { this.db = db; this.query = normalize(query); this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() {
    const [userId, bookRef] = this.values.map(String);
    if (this.query.includes('SELECT all_titles FROM telegram_subscription_settings')) {
      return { all_titles: this.db.allTitles.has(userId) ? 1 : 0 };
    }
    if (this.query.includes('SELECT 1 AS subscribed FROM title_subscriptions')) {
      return this.db.explicit.has(`${userId}:${bookRef}`) ? { subscribed: 1 } : null;
    }
    if (this.query.includes('SELECT 1 AS excluded FROM title_subscription_exclusions')) {
      return this.db.exclusions.has(`${userId}:${bookRef}`) ? { excluded: 1 } : null;
    }
    return null;
  }
  async all() {
    const [bookRef] = this.values.map(String);
    if (this.query.includes('SELECT user_telegram_id FROM telegram_subscription_settings WHERE all_titles = 1')) {
      return { results: [...this.db.allTitles].map((user_telegram_id) => ({ user_telegram_id })) };
    }
    if (this.query.includes('SELECT user_telegram_id FROM title_subscriptions WHERE book_ref = ?')) {
      return { results: [...this.db.explicit]
        .filter((key) => key.endsWith(`:${bookRef}`))
        .map((key) => ({ user_telegram_id: key.slice(0, key.indexOf(':')) })) };
    }
    if (this.query.includes('SELECT user_telegram_id FROM title_subscription_exclusions WHERE book_ref = ?')) {
      return { results: [...this.db.exclusions]
        .filter((key) => key.endsWith(`:${bookRef}`))
        .map((key) => ({ user_telegram_id: key.slice(0, key.indexOf(':')) })) };
    }
    return { results: [] };
  }
  async run() {
    if (this.query.startsWith('CREATE TABLE') || this.query.startsWith('CREATE INDEX') || this.query.startsWith('ALTER TABLE')) {
      return { meta: { changes: 0 } };
    }
    if (this.query.startsWith('INSERT OR IGNORE INTO title_subscription_exclusions')) {
      const key = `${this.values[0]}:${this.values[1]}`;
      const before = this.db.exclusions.size;
      this.db.exclusions.add(key);
      return { meta: { changes: this.db.exclusions.size - before } };
    }
    if (this.query.startsWith('DELETE FROM title_subscription_exclusions WHERE user_telegram_id = ? AND book_ref = ?')) {
      return { meta: { changes: this.db.exclusions.delete(`${this.values[0]}:${this.values[1]}`) ? 1 : 0 } };
    }
    if (this.query.startsWith('INSERT OR IGNORE INTO title_subscriptions')) {
      const key = `${this.values[0]}:${this.values[1]}`;
      const before = this.db.explicit.size;
      this.db.explicit.add(key);
      return { meta: { changes: this.db.explicit.size - before } };
    }
    if (this.query.startsWith('DELETE FROM title_subscriptions WHERE user_telegram_id = ? AND book_ref = ?')) {
      return { meta: { changes: this.db.explicit.delete(`${this.values[0]}:${this.values[1]}`) ? 1 : 0 } };
    }
    if (this.query.startsWith('INSERT OR IGNORE INTO ranobelib_notification_outbox')) {
      const key = `${this.values[0]}:${this.values[1]}`;
      const before = this.db.outbox.size;
      this.db.outbox.add(key);
      return { meta: { changes: this.db.outbox.size - before } };
    }
    return { meta: { changes: 0 } };
  }
}

class DB {
  constructor() {
    this.allTitles = new Set(['42']);
    this.explicit = new Set(['42:1000--one']); // stale explicit row must not override an all-mode exclusion.
    this.exclusions = new Set();
    this.outbox = new Set();
  }
  prepare(query) { return new Statement(this, query); }
}

test('all-mode user can opt out of exactly one title and release fanout respects that exclusion', async () => {
  const db = new DB();
  const env = { DB: db };
  const bookRef = '1000--one';

  assert.equal(await isEffectivelySubscribed(env, '42', bookRef), true);

  await setEffectiveTitleSubscription(env, '42', bookRef, false);
  assert.ok(db.exclusions.has(`42:${bookRef}`));
  assert.equal(await isEffectivelySubscribed(env, '42', bookRef), false);
  assert.equal(await enqueueReleaseNotifications(env, 'release-off', bookRef), 0);
  assert.equal(db.outbox.size, 0);

  await setEffectiveTitleSubscription(env, '42', bookRef, true);
  assert.equal(db.exclusions.has(`42:${bookRef}`), false);
  assert.equal(await isEffectivelySubscribed(env, '42', bookRef), true);
  assert.equal(await enqueueReleaseNotifications(env, 'release-on', bookRef), 1);
  assert.ok(db.outbox.has('release-on:42'));
});
