# Media recovery and output

| State | Meaning | Next action |
| --- | --- | --- |
| `queued` | Waiting for execution | Poll the same id at a bounded interval |
| `processing` | Running, uploading or canceling | Continue checking the same id |
| `succeeded` | Complete | Return `assets[].url` and available usage |
| `failed` | Terminal failure | Report the error; do not silently resubmit |
| `canceled` | Terminal cancellation | Report cancellation |

CLI `task wait ID --timeout 300 --interval 3` only reads. Exit 3 means waiting ended, exit 2 means a failed/canceled task, and exit 1 means input/network/API failure. API errors while waiting include the original task id. `run` emits its newly created id/key to stderr before waiting. Retain these even if the process is later interrupted.

`Idempotency-Key` is required by the API. Same request + same key returns the existing task. Same key + changed request returns 409. Reusing a key for an intentionally new task is wrong; replacing it during an uncertain retry is also wrong.

The response uses `id`, `status`, optional `progress`, `assets` and `usage`. Signed asset URLs are short lived. Query task details again for fresh URLs; do not recreate the task to obtain a new download link. A cancellation request can return `processing` before becoming terminal. Refund and final billing are API-owned facts, not something the client can deduce from a local timeout.
