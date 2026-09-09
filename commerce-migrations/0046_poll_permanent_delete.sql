-- Scoped authorization exists only inside the atomic permanent-delete transaction.
CREATE TABLE poll_deletion_guards (poll_id TEXT PRIMARY KEY REFERENCES polls(id), valid INTEGER NOT NULL CHECK(valid=1));
DROP TRIGGER poll_credit_allocation_immutable_delete;
CREATE TRIGGER poll_credit_allocation_immutable_delete BEFORE DELETE ON poll_credit_allocations WHEN NOT EXISTS(SELECT 1 FROM poll_deletion_guards g JOIN poll_credit_lots l ON l.poll_id=g.poll_id WHERE l.id=OLD.lot_id) BEGIN SELECT RAISE(ABORT,'immutable poll evidence'); END;
DROP TRIGGER poll_credit_audit_immutable_delete;
CREATE TRIGGER poll_credit_audit_immutable_delete BEFORE DELETE ON poll_credit_audit WHEN NOT EXISTS(SELECT 1 FROM poll_deletion_guards g JOIN poll_credit_lots l ON l.poll_id=g.poll_id WHERE l.id=OLD.lot_id) BEGIN SELECT RAISE(ABORT,'immutable poll evidence'); END;
DROP TRIGGER poll_manual_votes_delete;
CREATE TRIGGER poll_manual_votes_delete BEFORE DELETE ON poll_manual_votes WHEN NOT EXISTS(SELECT 1 FROM poll_deletion_guards WHERE poll_id=OLD.poll_id) BEGIN SELECT RAISE(ABORT,'immutable poll evidence'); END;
DROP TRIGGER poll_history_immutable_delete;
CREATE TRIGGER poll_history_immutable_delete BEFORE DELETE ON poll_result_history WHEN NOT EXISTS(SELECT 1 FROM poll_deletion_guards WHERE poll_id=OLD.poll_id) BEGIN SELECT RAISE(ABORT,'immutable poll evidence'); END;
