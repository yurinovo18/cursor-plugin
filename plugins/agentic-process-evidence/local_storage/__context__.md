Local session-event storage, including intake and the watched-git collection.
Owns hook-payload → record shape, JSONL spool, and `*.watched_git.json` (repo `.git` + logged HEAD + cids). Not upload. Watch list is filled by `git_finder` after a content-SHA change, not on every hashed path.
Entry: `session_objects_logic/record.js`, `db.js`, `watched_git.js`
