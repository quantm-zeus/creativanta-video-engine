# Video Engine autonomous supervisor

This is an independent worker scheduler for the Video Engine repository. It follows the architecture of the Creativanta agent harness but has its own Docker service, SQLite state, worktrees, budget, and GitHub staging branch.

## Operation

From tooling/agent_harness run these commands:

    python3 -m unittest discover -s tests -v
    docker compose build
    docker compose up -d
    docker compose ps
    docker compose exec -T supervisor python3 /opt/harness/supervisor.py status
    docker compose logs --tail 50 supervisor

The Docker restart policy is unless-stopped. The scheduler monitors its heartbeat and exits on prolonged hangs so Docker can restart it. Work progress persists in data/state.sqlite3 and data/status.json, with individual agent attempts in data/logs. Worktrees are isolated under the repository's .worktrees directory.

Task completion requires real evidence and a Git commit, GitHub PR, passing CI and integration into staging. Neither production nor main is updated by AGY. Some tasks require manual security, legal, or creative review.

The config.json file controls the pause flag, agent models, concurrency and per-task timeouts. The scheduler has NO per-day launch limit. The initial limit is two independent agents at a time; dependencies still gate starts. Do not delete data/ or .worktrees/ during troubleshooting.

A running container or a green health check is not evidence that a product feature is implemented. Use the GitHub staging history, evidence reports and real video artifacts for feature progress.

## No artificial AGY daily quota

The max_runs_per_24h setting was a self-imposed supervisor limit, not an AGY provider limit.
As of the next supervisor process start, dispatch ignores this value entirely. While an
older Python process is still serving live worker sessions, a high legacy value is retained
in config.json solely for backward compatibility to avoid interrupting active agents.
Only two AGY workers run concurrently, and each task retains the existing bounded retry,
resource and runtime constraints. STARTED events are still recorded for monitoring,
but never suppress new dispatches based on a time window.
