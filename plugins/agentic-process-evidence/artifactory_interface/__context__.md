Session bundle construction and Artifactory integration.
Owns `.tgz` assembly, `jf rt upload`, commit indexes. Upload is triggered by `git_watcher` on new HEAD (optional hook `live_publish` if `APPTRUST_LIVE_PUBLISH=1`).
Entry: `export_session.js`, `session_bundle.js`, `publish.js`
