# Community comment reaction types

Migration 019 adds a reaction type to existing comment and reply likes. Existing rows keep their comment, user, and creation time and become Like reactions. A user can still have only one reaction per comment. The API keeps supporting the existing boolean Like requests. Without migration 019, comments still load and Likes still work; the picker offers Heart once the database supports it.

Before applying 019, inspect the migration ledger and back up the verified target database. Review every pending migration before running `npm run migrate:mysql`, which applies all pending files. The separate 017–018 procedure does not cover 019. Check the original reaction row count during a pause in writes, then verify that switching Like to Heart keeps one row and that removing it deletes that row. If the column exists but the migration is missing from the ledger, stop and investigate before retrying; MySQL can commit the schema change before the ledger write.

For application rollback, keep the additive column so stored Hearts are preserved. The previous app can still count and remove those reactions, but displays them as Likes. Dropping the column using the rollback SQL discards the distinction between Like and Heart for all remaining rows. Back up those values first if a schema rollback is required.
