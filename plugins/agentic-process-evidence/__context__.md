Local client that records an agent session, binds file changes to git, and ships a session bundle to Artifactory.
Flow: Cursor hooks → pre/post content SHA → on digest change, `affected_git` + watch that `.git`. `git_watcher` uploads when HEAD moves off the logged commit. Viewer on `:8790` reads the spool.
Owns this tree: `hooks/`, `local_storage/` (includes `session_objects_logic/` intake), `change_detector/`, `git_finder/`, `git_watcher/`, `artifactory_interface/`, `viewer/`, `paths.js`. Stdlib Node only; system bins `git`, `jf`, `tar`.
Entry: `README.md`, `flow.md`, `hooks/install.js`, `viewer/zen_server.js`.
