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

The config.json file controls the pause flag, agent models, concurrency, timeouts and daily invocation cap. The initial limit is two independent agents at a time; dependencies still gate starts. Do not delete data/ or .worktrees/ during troubleshooting.

A running container or a green health check is not evidence that a product feature is implemented. Use the GitHub staging history, evidence reports and real video artifacts for feature progress.
