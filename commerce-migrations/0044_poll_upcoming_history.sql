CREATE TABLE poll_result_history (
 id TEXT PRIMARY KEY,
 poll_id TEXT NOT NULL REFERENCES polls(id),
 actor_account_id TEXT NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 ordinary_votes_json TEXT NOT NULL CHECK(json_valid(ordinary_votes_json)),
 created_at TEXT NOT NULL
);
CREATE INDEX poll_result_history_poll ON poll_result_history(poll_id,created_at);
CREATE TABLE poll_reset_windows (window_id TEXT PRIMARY KEY REFERENCES poll_voting_windows(id), history_id TEXT NOT NULL REFERENCES poll_result_history(id));
CREATE TABLE poll_reset_credit_lots (lot_id TEXT PRIMARY KEY REFERENCES poll_credit_lots(id), history_id TEXT NOT NULL REFERENCES poll_result_history(id));
CREATE TABLE poll_reset_manual_votes (request_id TEXT PRIMARY KEY REFERENCES poll_manual_votes(request_id), history_id TEXT NOT NULL REFERENCES poll_result_history(id));
CREATE TRIGGER poll_history_immutable_update BEFORE UPDATE ON poll_result_history BEGIN
 SELECT RAISE(ABORT,'poll_history_immutable');
END;
CREATE TRIGGER poll_history_immutable_delete BEFORE DELETE ON poll_result_history BEGIN
 SELECT RAISE(ABORT,'poll_history_immutable');
END;
CREATE TRIGGER poll_ordinary_result_insert AFTER INSERT ON poll_votes BEGIN
 UPDATE polls SET results_revision=results_revision+1 WHERE id=NEW.poll_id;
END;
CREATE TRIGGER poll_ordinary_result_update AFTER UPDATE ON poll_votes BEGIN
 UPDATE polls SET results_revision=results_revision+1 WHERE id=NEW.poll_id;
END;
CREATE TRIGGER poll_ordinary_result_delete AFTER DELETE ON poll_votes BEGIN
 UPDATE polls SET results_revision=results_revision+1 WHERE id=OLD.poll_id;
END;
UPDATE polls SET is_public=1 WHERE state='draft' AND opened_at IS NULL;
