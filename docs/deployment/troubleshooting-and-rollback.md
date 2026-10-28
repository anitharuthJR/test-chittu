# Troubleshooting and rollback

| Field | Value |
|---|---|
| Document version | 0.1 |
| Prepared | 2026-10-27 |
| Application revision | Deployed SHA pending |
| Model revision | Disk revision pending |
| Environment | EC2 `i-0f99f1c94ff3ff3e6` |
| Author role | Deployment audit |
| Reviewer | Pending |
| Approval status | Draft |

Commands below are the ones that matched the units installed on 2026-10-26. They were not re-run on 2026-10-27 because SSH timed out. Confirm `systemctl cat` before treating a unit as present.

## 1. The address does not connect

Observed on 2026-10-27: ports 22, 80, 443, 8080, and 8001 on `3.104.224.113` timed out from the operator workstation.

Check, in the AWS console, in `ap-southeast-2`, without changing rules yet:

1. Instance `i-0f99f1c94ff3ff3e6` state.
2. The current public IPv4. An address that was not an Elastic IP changes across stop and start.
3. Security group `launch-wizard-2` inbound rules.
4. Whether this workstation's public IP changed. On 2026-10-26 it was `223.185.25.232`. That was not a confirmed security-group source, only the workstation address at that time.

Do not open 5173, 8080, or 8001 to `0.0.0.0/0`. Those processes were bound to loopback on purpose.

## 2. Story model

```bash
systemctl status chittu-story.service --no-pager
journalctl -u chittu-story.service -n 80 --no-pager
curl -sS http://127.0.0.1:8001/health
ss -lnt | awk "NR==1 || /:8001/"
```

Healthy body: `{"status":"ok","model":"chittu-story-v0-26m"}` and the listen address `127.0.0.1:8001`.

| Log | Meaning | Action taken when this happened |
|---|---|---|
| `No module named 'nanochat.gpt'` | `PYTHONPATH` missing `/home/ubuntu/nanochat` | Correct the unit environment and restart. Do not pip-install a different nanochat over the checkout. |
| `Loading Chittu story model...` then exit | Weights or torch failed after the import. The successful start did not hit this. | Read the traceback. Do not delete `~/chittu-story-v0-26m`. |
| `GET /chat/completions` 405 | A browser opened the URL. | Expected. POST, or use `GET /`. |
| `POST /embeddings` 404 | Chittu's corpus client called a route the wrapper does not implement. | Expected with this wrapper. Do not fake a 200. |

Restart:

```bash
sudo systemctl restart chittu-story.service
```

The model loads again. One observed load was about four seconds from unit start to listen. Memory headroom was not measured under load. If the kernel OOM-kills python, `journalctl -k` will say so. Recovery is a restart after freeing disk or stopping the API, not a larger swap file added in a hurry.

## 3. Chittu API

```bash
systemctl status chittu-api.service --no-pager
journalctl -u chittu-api.service -n 80 --no-pager
curl -sS http://127.0.0.1:8080/health
```

The boot lines that matter:

- `providers configured: local` means `CHITTU_LOCAL_BASE_URL` was set. It does not mean every cell uses it.
- `cells name unreachable providers` lists cells whose provider has no adapter. On 2026-10-26 those were the Anthropic cells.
- `routing overrides IN EFFECT` is the cell environment, not proof the catalogue in the workspace allows that model. Diff `cells.ts` if this line names `chittu-story-v0-26m`.
- `FAST-PATH-ONLY` on a turn means the classifier did not return a verdict.
- `CORPUS UNAVAILABLE` means the embedder call failed. On this box the embedder URL returns 404.

If `/health` fails and the log names the database, check the container:

```bash
docker ps -a --filter name=chittu-postgres-dev-1
docker inspect chittu-postgres-dev-1 --format "{{json .HostConfig.PortBindings}}"
```

The verified binding is `127.0.0.1:55433`. If a later copy of `compose.yaml` publishes `0.0.0.0:55433`, recreate from the loopback line. Do not delete the volume `chittu_chittu-dev-data`.

Do not regenerate `CHITTU_DEV_MASTER_KEY` if the volume has data that must remain readable. The current key is only in `/home/ubuntu/.config/chittu/api.env`.

## 4. Caddy

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
systemctl status caddy --no-pager
curl -sSI http://127.0.0.1/health
```

`Server: Werkzeug` means Caddy is forwarding to Flask. A Chittu JSON body from `/health` without the model name means Caddy is forwarding to the Node API. Basic auth returns 401 before either body.

Rollback of the public edge to the product site is a Caddyfile change plus `systemctl reload caddy`, and it requires the API to be running. The repository file to start from is `deploy/demo/Caddyfile`. It expects:

- site name `chittu.tulifo.ai`
- a real basic-auth hash
- files in `/srv/chittu-web`
- API on `127.0.0.1:8080`

Do not reload that file while DNS still points at `13.205.39.18`. Caddy would try to obtain a certificate for a name that does not point here. On 2026-10-26 that certificate step was intentionally skipped.

To return to the model-only proxy, the verified behavior is port 80 forwarding to `127.0.0.1:8001`. Keep the Flask process on loopback.

## 5. After reboot

Not tested. The unit files were enabled for `chittu-story` and, at install time, `chittu-api` and `caddy`. Docker restart policy `unless-stopped` was set on `chittu-postgres-dev-1`. A reboot test is still required before anyone relies on that. After the next boot, run the status commands in sections 2–4. If the public address changed, the old URL will not follow the instance.

## 6. Disk and dependencies

```bash
df -h /
du -sh /home/ubuntu/chittu-story-v0-26m /home/ubuntu/nanochat /home/ubuntu/chittu
```

The 2026-10-26 reading was 13G used of 28G, with the model already present. `du` of the model directory was not taken.

Node and Python versions that matched the running tree: Node 22.23.4, pnpm 11.9.0, Python 3.14.4. A newer system Python that breaks the venv symlink is a model-load failure. The venv interpreter is a symlink to `/usr/bin/python3`.

## 7. Rollback limits

| Change | Rollback |
|---|---|
| Browser form in `chittu-story-api.py` | Restore the file from the copy that had only `/health` and `/chat/completions`, then restart the unit. No git revision exists on the box. Make a copy before editing. |
| Caddy model proxy | Replace the Caddyfile and reload. |
| API environment file | Do not delete it to "reset" the app. Back it up to a place that is not the world-writable tree, then keep the backup as restricted as the file. |
| Postgres volume | `docker compose down` without `-v` keeps it. `down -v` deletes demo data. That deletion was not performed. |
| Security group and DNS | Not changed by the verified AWS calls. There is nothing to roll back in AWS from this session. If an operator changed them in the console afterward, the console is the record. |

## 8. Logs and retention

```bash
journalctl -u chittu-story.service --since "1 hour ago"
journalctl -u chittu-api.service --since "1 hour ago"
```

The API logger is configured to redact message bodies. The story wrapper logs the HTTP line, not the prompt. Do not add request-body logging to make debugging easier. Journal size and rotation were not inspected.
