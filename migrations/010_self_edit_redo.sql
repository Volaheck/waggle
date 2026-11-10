-- A request that brought an undone change back points at that change, so a reply to its notice is about the same change.
ALTER TABLE self_edits ADD COLUMN redo_of bigint REFERENCES self_edits(id) ON DELETE SET NULL;
