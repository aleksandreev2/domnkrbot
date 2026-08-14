CREATE TABLE IF NOT EXISTS proposal_votes (
  proposal_id TEXT NOT NULL,
  user_telegram_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (proposal_id, user_telegram_id),
  FOREIGN KEY (proposal_id) REFERENCES chapter_proposals(id) ON DELETE CASCADE,
  FOREIGN KEY (user_telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_proposal_votes_proposal
  ON proposal_votes(proposal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proposal_votes_user
  ON proposal_votes(user_telegram_id, created_at DESC);
