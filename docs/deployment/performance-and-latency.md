# Performance and latency

| Field | Value |
|---|---|
| Document version | 0.1 |
| Prepared | 2026-10-27 |
| Application revision | `0.1.0`; deployed SHA pending |
| Model revision | Disk revision pending |
| Environment | `m7i-flex.large`, 2 vCPU, 7.6 GiB RAM, CPU inference, `ap-southeast-2a` |
| Author role | Deployment audit |
| Reviewer | Pending |
| Approval status | Draft. Not a capacity plan. |

## 1. What was not a benchmark

A repeatable suite was not executed. On 2026-10-27 the instance did not accept TCP connections from the audit workstation, so no new samples were taken. Percentiles, throughput, and concurrency are **pending**. They are not estimated from two requests.

Streaming is not implemented. The Flask wrapper returns one JSON body after generation finishes. Time to first token cannot be measured on this API.

## 2. Observations that were recorded

Conditions for the generation rows: prompt "Tell me a story about a brave little sparrow.", temperature 0.6, top-k 50, seed 42, those three fixed in `chittu-story-api.py`. The process was already warm (the model had logged "loaded" earlier). CPU and RSS during the call were not sampled.

| When (UTC) | Path | max_tokens | Reported generation_seconds | Wall clock around the call | Output | Source |
|---|---|---|---|---|---|---|
| 2026-10-26, during the on-box check | `POST 127.0.0.1:8001/chat/completions` | 60 | 1.197 | about 1.2 s for the Python client | 257 characters | On-box script |
| 2026-10-26, from the operator workstation | `POST http://3.104.224.113/chat/completions` | 40 | 0.717 | not separately instrumented; the command returned in the same exchange | 40 completion tokens, 12 prompt tokens | Public curl |
| 2026-10-26 | Consented `POST /v1/.../turn` on `127.0.0.1:8080` | adapter default, wrapper clamps to at most 200 | not isolated | the whole consent-plus-turn script returned in about 21 s, which includes consent and is not a model latency | 814 characters, same opening as the direct call | On-box script |

Startup, one process start, not a sample:

| Event | UTC timestamp |
|---|---|
| systemd started `chittu-story.service` | 2026-10-26 08:17:30 |
| log line "Loading Chittu story model..." | 08:17:33 |
| log line "Chittu story model loaded." | 08:17:34 |
| Flask listening | 08:17:34 |

That is about one second between the loading line and the loaded line, and about four seconds from the unit start to listen. It is one observation after a crash loop, not a cold-start distribution. Disk cache state was unknown.

Idle memory before this restart: 522 MiB used of 7.6 GiB. That sample was taken before the successful model process was up. The 297.8 MiB figure in the journal is the peak of a failed import, not the loaded model. Do not use it as the working set.

Disk at first inspection: 13G used of 28G. The model directory was already present. Its own size was not measured.

No error or timeout was observed on the three generation calls above. That is not an error rate.

The operator-reported 2.724 second generation was not reproduced in this session and is not included as a measurement.

## 3. Raw rows

`docs/deployment/measurements/latency-observations.csv` contains the two direct generation rows. It is not a benchmark output.

## 4. Runnable check, not yet run

Save as a file on a machine that can reach the model and run it only with approval. It was not run on 2026-10-27.

```bash
#!/bin/bash
# Warm sequential samples. Does not start or stop services.
set -euo pipefail
URL="${URL:-http://127.0.0.1:8001/chat/completions}"
N="${N:-20}"
OUT="${OUT:-latency.csv}"
echo "n,http,generation_seconds,completion_tokens,wall_seconds" > "$OUT"
for i in $(seq 1 "$N"); do
  body='{"messages":[{"role":"user","content":"Tell me a story about a brave little sparrow."}],"max_tokens":40}'
  start=$(date +%s.%N)
  resp=$(curl -sS --max-time 120 -X POST "$URL" -H "Content-Type: application/json" -d "$body" -w "\nHTTP:%{http_code}")
  end=$(date +%s.%N)
  code=$(printf "%s" "$resp" | awk -F: "/^HTTP:/{print \$2}")
  json=$(printf "%s" "$resp" | sed "/^HTTP:/d")
  gen=$(printf "%s" "$json" | python3 -c "import sys,json; print(json.load(sys.stdin).get(\"generation_seconds\",\"\"))")
  toks=$(printf "%s" "$json" | python3 -c "import sys,json; print(json.load(sys.stdin).get(\"usage\",{}).get(\"completion_tokens\",\"\"))")
  wall=$(python3 -c "print(round($end - $start, 3))")
  echo "$i,$code,$gen,$toks,$wall" >> "$OUT"
done
```

Run once to warm the process, discard that row, then run `N=20` at concurrency 1. A second run with a parallel client is a different test and was not defined here because the host was unreachable. Record `nproc`, `free -h`, and `pidstat` or `ps` RSS for the python PID during the run. Do not compute p95 from fewer than 20 successful warm rows.

## 5. Is this CPU box appropriate?

**Not answered by the data.** Two warm calls of 40 and 60 tokens finished in under two seconds on a 2 vCPU instance. That says a single demonstration request can complete. It does not say how the box behaves with concurrent sessions, longer outputs, or the Chittu API and Postgres beside the model.

The wrapper is single-process Flask. One generation occupies the interpreter. A second request waits. That is a structural limit, independent of the two samples.

No GPU price or GPU latency was collected. Recommending a GPU would be a guess.
