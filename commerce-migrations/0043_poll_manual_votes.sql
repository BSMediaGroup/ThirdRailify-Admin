CREATE TABLE poll_manual_votes (
 request_id TEXT PRIMARY KEY,
 poll_id TEXT NOT NULL REFERENCES polls(id),
 option_id TEXT NOT NULL REFERENCES poll_options(id),
 actor_account_id TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount BETWEEN 1 AND 10000),
 created_at TEXT NOT NULL
);
CREATE INDEX poll_manual_votes_option ON poll_manual_votes(poll_id,option_id);
CREATE TRIGGER poll_manual_votes_guard BEFORE INSERT ON poll_manual_votes WHEN NOT EXISTS(SELECT 1 FROM polls p JOIN poll_options o ON o.poll_id=p.id WHERE p.id=NEW.poll_id AND o.id=NEW.option_id AND p.state='open' AND p.is_public=1) BEGIN
 SELECT RAISE(ABORT,'poll_manual_vote_closed');
END;
CREATE TRIGGER poll_manual_votes_update BEFORE UPDATE ON poll_manual_votes BEGIN
 SELECT RAISE(ABORT,'poll_manual_votes_immutable');
END;
CREATE TRIGGER poll_manual_votes_delete BEFORE DELETE ON poll_manual_votes BEGIN
 SELECT RAISE(ABORT,'poll_manual_votes_immutable');
END;
CREATE TRIGGER poll_manual_votes_revision AFTER INSERT ON poll_manual_votes BEGIN
 UPDATE polls SET results_revision=results_revision+1 WHERE id=NEW.poll_id;
END;
CREATE TRIGGER poll_manual_votes_option_guard BEFORE UPDATE OF poll_id,trigger_normalized ON poll_options WHEN EXISTS(SELECT 1 FROM poll_manual_votes WHERE option_id=OLD.id) AND (NEW.poll_id<>OLD.poll_id OR NEW.trigger_normalized<>OLD.trigger_normalized) BEGIN
 SELECT RAISE(ABORT,'poll_manual_votes_structure_locked');
END;
