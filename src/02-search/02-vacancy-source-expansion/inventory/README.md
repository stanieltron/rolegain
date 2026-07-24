# Persistent vacancy-source inventory

Each source checkpoint is stored under the candidate rather than under a single
search run. The checkpoint records the source URL, next pagination URL, seen
vacancy URLs, yield counters, freshness timestamps, and whether more pages are
available.

An unknown remainder is represented by `cursorUrl` plus `hasMore=true`; the
system does not invent an exact remaining count when the source does not expose
one. A later next-five run loads these files and resumes the source even when a
fresh web search does not rediscover it.
