-- Additive Poll authority. Product defaults are not provider guarantees.
ALTER TABLE polls ADD COLUMN presentation_type TEXT NOT NULL DEFAULT 'regular' CHECK(presentation_type IN ('regular','abootnothing'));
ALTER TABLE polls ADD COLUMN presentation_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(presentation_json));
ALTER TABLE polls ADD COLUMN results_revision INTEGER NOT NULL DEFAULT 0;
CREATE INDEX polls_collection_idx ON polls(presentation_type,is_public,state,closed_at);

CREATE TABLE poll_voting_policies (
 poll_id TEXT PRIMARY KEY REFERENCES polls(id), revision INTEGER NOT NULL CHECK(revision>0),
 policy_json TEXT NOT NULL CHECK(json_valid(policy_json)), updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
);
CREATE TABLE poll_voting_windows (
 id TEXT PRIMARY KEY, poll_id TEXT NOT NULL REFERENCES polls(id), source_scope TEXT NOT NULL,
 opened_at TEXT NOT NULL, ended_at TEXT, policy_revision INTEGER NOT NULL,
 policy_json TEXT NOT NULL CHECK(json_valid(policy_json)), options_json TEXT NOT NULL CHECK(json_valid(options_json)),
 livestream_id TEXT, stream_mode TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 observed_through TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX poll_window_active_source ON poll_voting_windows(source_scope) WHERE ended_at IS NULL;
CREATE INDEX poll_window_poll ON poll_voting_windows(poll_id,ended_at);
CREATE TABLE poll_credit_lots (
 id TEXT PRIMARY KEY, event_fingerprint TEXT NOT NULL UNIQUE, evidence_version INTEGER NOT NULL DEFAULT 1,
 poll_id TEXT NOT NULL REFERENCES polls(id), window_id TEXT NOT NULL REFERENCES poll_voting_windows(id),
 kind TEXT NOT NULL CHECK(kind IN ('rant','gift')), source_scope TEXT NOT NULL, livestream_id TEXT,
 actor_key TEXT, actor_label TEXT, provider_event_at TEXT NOT NULL,
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
 earned INTEGER NOT NULL CHECK(earned BETWEEN 1 AND 500000000),
 committed INTEGER NOT NULL DEFAULT 0 CHECK(committed>=0), waiting INTEGER NOT NULL DEFAULT 0 CHECK(waiting>=0),
 unreconciled INTEGER NOT NULL DEFAULT 0 CHECK(unreconciled>=0), discarded INTEGER NOT NULL DEFAULT 0 CHECK(discarded>=0),
 attempts_used INTEGER NOT NULL DEFAULT 0 CHECK(attempts_used BETWEEN 0 AND 3),
 max_messages INTEGER NOT NULL CHECK(max_messages BETWEEN 1 AND 3), expires_at TEXT NOT NULL,
 reason TEXT, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK(earned=committed+waiting+unreconciled+discarded)
);
CREATE INDEX poll_credit_waiting ON poll_credit_lots(window_id,actor_key,waiting,provider_event_at);
CREATE INDEX poll_credit_review ON poll_credit_lots(poll_id,unreconciled,created_at);
CREATE INDEX poll_credit_expiry ON poll_credit_lots(expires_at) WHERE waiting>0;
CREATE TABLE poll_credit_messages (
 window_id TEXT NOT NULL REFERENCES poll_voting_windows(id), fingerprint TEXT NOT NULL,
 actor_key TEXT NOT NULL, provider_event_at TEXT NOT NULL, option_id TEXT REFERENCES poll_options(id),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), PRIMARY KEY(window_id,fingerprint)
);
CREATE TABLE poll_credit_attempts (
 lot_id TEXT NOT NULL REFERENCES poll_credit_lots(id), message_fingerprint TEXT NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(lot_id,message_fingerprint)
);
CREATE TABLE poll_credit_allocations (
 id TEXT PRIMARY KEY, lot_id TEXT NOT NULL REFERENCES poll_credit_lots(id),
 option_id TEXT NOT NULL REFERENCES poll_options(id), amount INTEGER NOT NULL CHECK(amount<>0),
 actor_account_id TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX poll_credit_option ON poll_credit_allocations(option_id,lot_id);
CREATE TRIGGER poll_credit_allocation_immutable_update BEFORE UPDATE ON poll_credit_allocations BEGIN
 SELECT RAISE(ABORT,'poll_credit_allocation_immutable');
END;
CREATE TRIGGER poll_credit_allocation_immutable_delete BEFORE DELETE ON poll_credit_allocations BEGIN
 SELECT RAISE(ABORT,'poll_credit_allocation_immutable');
END;
CREATE TABLE poll_credit_audit (
 id TEXT PRIMARY KEY, lot_id TEXT NOT NULL REFERENCES poll_credit_lots(id),
 actor_account_id TEXT, action TEXT NOT NULL, reason TEXT NOT NULL,
 before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE poll_credit_batches (fingerprint TEXT PRIMARY KEY,window_id TEXT NOT NULL REFERENCES poll_voting_windows(id),created_at TEXT NOT NULL);
CREATE TRIGGER poll_credit_audit_immutable_update BEFORE UPDATE ON poll_credit_audit BEGIN
 SELECT RAISE(ABORT,'poll_credit_audit_immutable');
END;
CREATE TRIGGER poll_credit_audit_immutable_delete BEFORE DELETE ON poll_credit_audit BEGIN
 SELECT RAISE(ABORT,'poll_credit_audit_immutable');
END;
-- A failing guard aborts the entire D1 batch, including receipts and audits.
CREATE TABLE poll_credit_guards (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));

CREATE TRIGGER poll_credit_lot_insert AFTER INSERT ON poll_credit_lots BEGIN
 UPDATE polls SET results_revision=results_revision+1 WHERE id=NEW.poll_id;
END;
CREATE TRIGGER poll_credit_lot_update AFTER UPDATE ON poll_credit_lots BEGIN
 UPDATE polls SET results_revision=results_revision+1 WHERE id=NEW.poll_id;
END;
CREATE TRIGGER poll_credit_allocation_guard BEFORE INSERT ON poll_credit_allocations BEGIN
 SELECT RAISE(ABORT,'poll_credit_option_invalid') WHERE NOT EXISTS(SELECT 1 FROM poll_credit_lots l JOIN poll_options o ON o.poll_id=l.poll_id WHERE l.id=NEW.lot_id AND o.id=NEW.option_id);
 SELECT RAISE(ABORT,'poll_credit_correction_exceeded') WHERE NEW.amount<0 AND COALESCE((SELECT SUM(amount) FROM poll_credit_allocations WHERE lot_id=NEW.lot_id AND option_id=NEW.option_id),0)+NEW.amount<0;
END;
CREATE TRIGGER poll_credit_review_audit AFTER UPDATE ON poll_credit_lots WHEN OLD.waiting>NEW.waiting AND OLD.committed=NEW.committed AND OLD.discarded=NEW.discarded BEGIN
 INSERT INTO poll_credit_audit(id,lot_id,actor_account_id,action,reason,before_json,after_json,created_at)
 VALUES(lower(hex(randomblob(16))),NEW.id,NULL,'moved_to_review',COALESCE(NEW.reason,'review'),json_object('waiting',OLD.waiting,'unreconciled',OLD.unreconciled),json_object('waiting',NEW.waiting,'unreconciled',NEW.unreconciled),NEW.updated_at);
END;
CREATE TRIGGER poll_credit_window_end AFTER UPDATE OF ended_at ON poll_voting_windows WHEN OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL BEGIN
 UPDATE poll_credit_lots SET unreconciled=unreconciled+waiting,waiting=0,reason='window_ended',revision=revision+1,updated_at=NEW.ended_at WHERE window_id=NEW.id AND waiting>0;
END;
CREATE TRIGGER poll_credit_lifecycle AFTER UPDATE OF state,rumble_enabled ON polls WHEN NEW.state<>'open' OR NEW.rumble_enabled=0 BEGIN
 UPDATE poll_voting_windows SET ended_at=NEW.updated_at,revision=revision+1 WHERE poll_id=NEW.id AND ended_at IS NULL;
END;
CREATE TRIGGER poll_credit_structure_delete BEFORE DELETE ON poll_options WHEN EXISTS(SELECT 1 FROM poll_credit_lots WHERE poll_id=OLD.poll_id) BEGIN
 SELECT RAISE(ABORT,'poll_paid_structure_locked');
END;
CREATE TRIGGER poll_credit_structure_update BEFORE UPDATE OF trigger_normalized,poll_id ON poll_options WHEN (NEW.trigger_normalized<>OLD.trigger_normalized OR NEW.poll_id<>OLD.poll_id) AND EXISTS(SELECT 1 FROM poll_credit_lots WHERE poll_id=OLD.poll_id) BEGIN
 SELECT RAISE(ABORT,'poll_paid_structure_locked');
END;
