Local session-event storage, including intake and the watched-git collection.
Owns hook-payload → record shape, JSONL spool, and `*.watched_git.json` (repo `.git` + logged HEAD + session ids + pending files). Not upload. Watch list is filled by `git_finder` after a content-SHA change, not on every hashed path. After git_watcher publishes, pending files are cleared; session ids stay so the next HEAD move in the same session still matches.
Entry: `session_objects_logic/record.js`, `db.js`, `watched_git.js`
