-- Additive planning/publication authority. No season, vote or provider seed data.
CREATE TABLE aboot_brackets (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
 publication_id TEXT, public_slug TEXT UNIQUE,
 finalized INTEGER NOT NULL DEFAULT 0 CHECK(finalized IN (0,1)),
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE aboot_publications (
 id TEXT PRIMARY KEY, bracket_id TEXT NOT NULL REFERENCES aboot_brackets(id),
 graph_json TEXT NOT NULL CHECK(json_valid(graph_json)), created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE aboot_poll_links (
 id TEXT PRIMARY KEY, bracket_id TEXT NOT NULL REFERENCES aboot_brackets(id), match_id TEXT NOT NULL,
 poll_id TEXT NOT NULL REFERENCES polls(id), mapping_json TEXT NOT NULL CHECK(json_valid(mapping_json)),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX aboot_link_poll ON aboot_poll_links(poll_id) WHERE active=1;
CREATE UNIQUE INDEX aboot_link_match ON aboot_poll_links(bracket_id,match_id) WHERE active=1;
CREATE TABLE aboot_decisions (
 id TEXT PRIMARY KEY, bracket_id TEXT NOT NULL REFERENCES aboot_brackets(id), match_id TEXT NOT NULL,
 winner_id TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('poll','manual','historical','override','bye')),
 scores_json TEXT NOT NULL, fingerprint TEXT, link_id TEXT REFERENCES aboot_poll_links(id),
 reason TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL,
 superseded INTEGER NOT NULL DEFAULT 0 CHECK(superseded IN (0,1))
);
CREATE UNIQUE INDEX aboot_active_decision ON aboot_decisions(bracket_id,match_id) WHERE superseded=0;
CREATE TABLE aboot_audit (
 id TEXT PRIMARY KEY, bracket_id TEXT NOT NULL REFERENCES aboot_brackets(id),
 request_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL,
 details_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(bracket_id,request_id)
);
CREATE TRIGGER aboot_audit_no_update BEFORE UPDATE ON aboot_audit BEGIN SELECT RAISE(ABORT,'immutable bracket audit'); END;
CREATE TRIGGER aboot_audit_no_delete BEFORE DELETE ON aboot_audit BEGIN SELECT RAISE(ABORT,'immutable bracket audit'); END;
CREATE TABLE aboot_guards (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));
CREATE TABLE aboot_media (
 id TEXT PRIMARY KEY, bracket_id TEXT NOT NULL REFERENCES aboot_brackets(id),
 object_key TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL, byte_size INTEGER NOT NULL,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER aboot_publication_no_update BEFORE UPDATE ON aboot_publications BEGIN SELECT RAISE(ABORT,'immutable publication'); END;
CREATE TRIGGER aboot_publication_no_delete BEFORE DELETE ON aboot_publications BEGIN SELECT RAISE(ABORT,'immutable publication'); END;
CREATE TRIGGER aboot_decision_evidence_update BEFORE UPDATE ON aboot_decisions
WHEN NEW.id<>OLD.id OR NEW.bracket_id<>OLD.bracket_id OR NEW.match_id<>OLD.match_id OR NEW.winner_id<>OLD.winner_id OR NEW.source<>OLD.source OR NEW.scores_json<>OLD.scores_json OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.link_id IS NOT OLD.link_id OR NEW.reason<>OLD.reason OR NEW.actor<>OLD.actor OR NEW.created_at<>OLD.created_at OR NEW.superseded<OLD.superseded
BEGIN SELECT RAISE(ABORT,'immutable decision evidence'); END;
CREATE TRIGGER aboot_decision_no_delete BEFORE DELETE ON aboot_decisions BEGIN SELECT RAISE(ABORT,'immutable decision evidence'); END;
CREATE TRIGGER aboot_linked_option_no_delete BEFORE DELETE ON poll_options
WHEN EXISTS(SELECT 1 FROM aboot_poll_links WHERE poll_id=OLD.poll_id AND active=1)
BEGIN SELECT RAISE(ABORT,'linked bracket option identity is protected'); END;
CREATE TRIGGER aboot_linked_option_no_repurpose BEFORE UPDATE ON poll_options
WHEN (NEW.id<>OLD.id OR NEW.poll_id<>OLD.poll_id OR NEW.label<>OLD.label OR NEW.trigger_normalized<>OLD.trigger_normalized) AND EXISTS(SELECT 1 FROM aboot_poll_links WHERE poll_id=OLD.poll_id AND active=1)
BEGIN SELECT RAISE(ABORT,'linked bracket option identity is protected'); END;
