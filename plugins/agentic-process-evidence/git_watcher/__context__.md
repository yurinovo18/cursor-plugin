Poll HEAD of repos in the local watched-git collection.
On HEAD ≠ logged SHA, append the new commit onto matching session logs and publish those conversations through `artifactory_interface`. After a successful upload, ack the watch: clear pending files, keep session ids, keep the new logged SHA so a later commit in the same session still publishes. Failed uploads revert logged SHA.
Entry: `watch.js --watch`
