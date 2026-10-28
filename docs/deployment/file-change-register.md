# Deployment file-change register

| Field | Value |
|---|---|
| Document version | 0.1 |
| Prepared | 2026-10-27 |
| Application revision | Server tree has no git metadata. Selected files matched the workspace on 2026-10-26. |
| Model revision | Pending |
| Environment | EC2 `i-0f99f1c94ff3ff3e6` |
| Author role | Deployment audit |
| Reviewer | Pending |
| Approval status | Draft |

The instance was not reachable on 2026-10-27, so this register was not refreshed with a new `diff`. Rows are limited to changes observed in the 2026-10-26 session. The workspace git tree was not modified by that session. Server copies were.

| File/path | Original behavior | Change made | Reason | Impact | Risk | Evidence |
|---|---|---|---|---|---|---|
| `/home/ubuntu/chittu/compose.yaml` | Dev Postgres published `55433` on all host interfaces. | Host publish set to `127.0.0.1:55433:5432`. Container recreated. Volume `chittu_chittu-dev-data` retained. Restart policy set to `unless-stopped`. | Avoid publishing Postgres on the instance network. | Database reachable only on loopback. | A future `git` or WinSCP overwrite can restore the open publish. The workspace file was not updated, so the next copy from the workspace would revert it. | `docker inspect` port binding `127.0.0.1` / `55433` after recreate. |
| `/etc/caddy/Caddyfile` | No Caddy install at first contact. | Installed Caddy 2.11.7. First wrote a basic-auth site for the built frontend and `/v1`. Later the public behavior was a reverse proxy from port 80 to `127.0.0.1:8001` with no basic auth. | Operator asked for the model alone on port 80. | Public IP served Flask, not the Chittu UI. | Unauthenticated model generation on the internet. The exact file bytes were not re-read after the last public check. | Apt and `caddy validate` output. Later `GET /health` showed `Via: 1.1 Caddy` and `Server: Werkzeug`. |
| `/etc/systemd/system/chittu-api.service` | API was not a service. Nothing was listening on 8080 at first contact. | Unit created. `node dist/main.js`, environment file mode 600, restart on failure, enabled. | Keep the API up across logout. | API listened on `127.0.0.1:8080` and passed `/health`. | `NODE_ENV=development` and a dev master key. Whether the unit was stopped afterward was not re-read. | `systemctl enable` output and API boot log. |
| `/etc/systemd/system/chittu-story.service` | Story API was not running. | Unit created. First `PYTHONPATH` was incomplete and the unit crash-looped. `PYTHONPATH` was then set to `/home/ubuntu/nanochat:/home/ubuntu/chittu-story-v0-26m`. | Match the command previously used in the operator shell history. | Model stayed on `127.0.0.1:8001`. | Flask development server under systemd. Crash loop if `PYTHONPATH` is dropped. | Journal `ModuleNotFoundError`, then health JSON. |
| `/home/ubuntu/chittu-story-api.py` | `GET /health` and `POST /chat/completions` only. File is not in the git workspace. | Added `GET /` HTML form that posts to `/chat/completions`. Service restarted. | Browser address bar cannot POST, and F12 was not usable for the operator. | `http://<ip>/` generates stories in the browser. | UI bypasses Chittu's safety pipeline. The change is only on the instance. | Script printed `HOME_ADDED`. Public `GET /` returned `text/html`. Operator screenshot showed a story. |
| `/home/ubuntu/.config/chittu/api.env` | Absent. | Created mode 600. Names: `NODE_ENV`, `HOST`, `PORT`, `DATABASE_URL`, `CHITTU_DEV_MASTER_KEY`. | Stable dev encryption key and loopback database URL. | API could restart without minting a new key. | Loss of this file makes existing ciphertext unreadable. Values are not in this register. | `stat` mode 600. Boot log showed the database host without the password. |
| `/home/ubuntu/.config/chittu/basic-auth.password` and `basic-auth.hash` | Absent. | Created mode 600 for the earlier Caddy basic-auth site. | Repository Caddyfile requires a hash and forbids an empty gate. | Used while the Chittu site was on port 80. Not required by the later unauthenticated model proxy. | Password remains on disk. | File created. Contents not read back into the report. |
| `/srv/chittu-web` | Directory did not exist. | Created. Contents of `apps/web/dist` copied. `index.html` 1411 bytes. | Caddyfile `root` for the Chittu frontend. | Used only while Caddy served the frontend. Still on disk after the proxy change, but not served by the model-only proxy. | Stale bundle can be mistaken for the live site. | `find` listing and byte count. |
| `/home/ubuntu/chittu/apps/web/dist` and package `dist/` trees | `apps/web/dist` was absent. | `pnpm build` on the instance. | Production frontend and compiled API. | `node dist/main.js` could start. | Build products are untracked and will not survive a clean copy unless rebuilt. | Build log, exit 0, 2026-10-26 06:48 UTC. |
| Windows `~/.ssh/config` | No `chittu-ec2` host. | Host `chittu-ec2` added, `IdentitiesOnly yes`, identity file the existing pem. The key was not copied. | Repeat SSH without the default key. | Operator alias. | Config points at a key outside the repo. | SSH `hostname` returned `app`. |
| Workspace git files | Unchanged by this deployment. | None. | Avoid overwriting the catalogue and Caddyfile in git with POC edits. | Server and workspace can drift. | The next WinSCP of `compose.yaml` can reopen Postgres. | No workspace edit in the session. |

## Suspected or not verified

| Item | Why it is not confirmed |
|---|---|
| Operator ran `systemctl disable --now chittu-api` | The command was provided. A later `systemctl` reading was not taken. Public routing no longer reached the API, which does not prove the unit was stopped. |
| Final `/etc/caddy/Caddyfile` text | Behavior was verified by HTTP. The file was not printed, because an earlier version contained a password hash. |
| `cells.ts` on the server equals the workspace | Selected hashes matched. `cells.ts` was not hashed. The process accepted a model id the workspace catalogue does not list. |
| Hugging Face token used to download weights | The weight directory existed before this session. No token was read. |
| Security group rule that opened port 80 | Port 80 changed from closed to open on 2026-10-26. The AWS API call to describe or authorize rules failed. |

## Maintainable replacement

The instance changes should be represented in the repository, not only on the box:

- A Caddyfile variant for "model only on port 80" and the existing `deploy/demo/Caddyfile` for the product, so the two are not successive overwrites of `/etc/caddy/Caddyfile`.
- The systemd units and the `PYTHONPATH` under version control.
- The story wrapper moved from `/home/ubuntu/chittu-story-api.py` into the repository, including the decision about whether a browser form belongs there.
- `compose.yaml` loopback publish for port 55433, if that is the intended dev binding, committed so the next copy does not revert it.
- `chittu-story-v0-26m` either added to `MODEL_CATALOGUE` by review, or removed from `CHITTU_CELL_SANDBOX` if the catalogue rejection is the intended control.

None of those repository edits were made for this audit.
