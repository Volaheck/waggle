-- From here on a merge of projects is logged with who made it (mergeProjects in src/core/projects.ts): the weekly
-- clean-up as 'llm', and in the Mini App a member as 'user' or a bot owner as 'admin', with them as its actor. Until now
-- every merge was logged as the clean-up's, those made in the Mini App too, so the catalog's history keeps when that
-- stopped (catalogHistory): a merge logged as the clean-up's before it, and made with no call of the clean-up just
-- before it, was made by someone the log does not name.
INSERT INTO app_state (key, value) VALUES ('merge_makers_logged', jsonb_build_object('at', now()))
ON CONFLICT (key) DO NOTHING;

-- A merge made before the folded entry logged where it went (2026-11-09) has only the row of the entry it went into: the
-- folded entry gets its row too, so the catalog's history shows the merge and the duplicate's old name and slug lead to
-- the project it went into.
INSERT INTO change_log (entity, entity_id, op, after, source, actor_user_id, at)
SELECT 'project', folded.id, 'merged_into', jsonb_build_object('into', kept.id, 'slug', kept.slug), l.source, l.actor_user_id, l.at
FROM change_log l
JOIN projects kept ON kept.id = l.entity_id
JOIN projects folded ON folded.chat_id = kept.chat_id AND folded.slug = l.before->>'merged' AND folded.id <> kept.id AND folded.hidden
WHERE l.entity = 'project' AND l.op = 'merge'
  AND NOT EXISTS (SELECT 1 FROM change_log m WHERE m.entity = 'project' AND m.entity_id = folded.id AND m.op = 'merged_into');
