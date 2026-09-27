Changed path → Git repository, branch, HEAD, remote, and commit tags.
Owns Git metadata lookup and stamping `affected_git` on the event after a content-SHA change. Adds that `.git` to the watched collection. Not Git lifecycle watching.
Constraint: actual git data extraction must only use git CLI functions.
Entry: `gitmeta.js`, `git_links.js`, `bind.js`
