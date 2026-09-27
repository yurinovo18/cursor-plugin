# Flow

Agent session evidence: Cursor hook JSON in, session-bundle `.tgz` out to Artifactory when a watched repo HEAD moves off the commit logged at file-change time. Viewer reads the same local spool.

`change_detector` hashes extracted paths on `preToolUse` and `postToolUse` and compares content SHA-256. Only a digest mismatch runs `git_finder`, which stamps `affected_git` on that event and adds the repo `.git` to the watched collection (logged SHA = HEAD at that moment). `git_watcher` polls `git rev-parse HEAD` against that logged SHA. HEAD moved → append the new commit onto those session logs and upload all of them. Hook `live_publish` is off unless `APPTRUST_LIVE_PUBLISH=1`.

```mermaid
flowchart TB
  agent["Agent / Cursor"]
  hooks["hooks"]
  store["local_storage\nspool + watched .git"]
  detect["change_detector\npre/post content SHA"]
  finder["git_finder"]
  watcher["git_watcher\nHEAD vs logged SHA"]
  af["artifactory_interface"]
  bundle["bundle .tgz"]
  rt["Artifactory"]
  viewer["viewer :8790"]

  agent -->|"stdin JSON"| hooks
  hooks -->|"fail-open reply"| agent
  hooks --> detect
  detect -->|"SHA changed"| finder
  finder -->|"affected_git + watch .git"| store
  hooks --> store
  store --> viewer
  store --> watcher
  watcher -->|"HEAD moved"| store
  watcher -->|"upload all matching sessions"| af
  af --> bundle
  bundle -->|"jf rt upload + commit index"| rt
```

## Per hook event

```mermaid
sequenceDiagram
  participant Cursor
  participant hooks
  participant change_detector
  participant git_finder
  participant local_storage

  Cursor->>hooks: hook JSON on stdin
  hooks->>change_detector: extract paths, sha256 pre and post
  change_detector->>change_detector: compare content SHA
  alt digest changed
    hooks->>git_finder: fileInfo(path)
    git_finder-->>hooks: commit + repo coords
    hooks->>local_storage: append event with affected_git
    hooks->>local_storage: watch that .git at logged HEAD
  else digest unchanged
    hooks->>local_storage: append event only
  end
  hooks-->>Cursor: continue / allow
```

## On HEAD move

```mermaid
sequenceDiagram
  participant git_watcher
  participant local_storage
  participant artifactory_interface
  participant Artifactory

  git_watcher->>local_storage: read watched .git collection
  git_watcher->>git_watcher: git rev-parse HEAD vs logged_sha
  git_watcher->>local_storage: append gitHeadChanged onto matching session logs
  git_watcher->>artifactory_interface: exportSession(cid, publish true) for each
  artifactory_interface->>Artifactory: jf rt upload session-bundle.tgz
```

`artifactory_interface` reads the spool, builds a session view (timeline + change evidence), asks `git_finder` for repo/commit tags, packs `manifest.json` + `session.json` + `events.jsonl` into a `.tgz`, then `jf rt upload`.
