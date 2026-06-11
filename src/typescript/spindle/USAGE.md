# Run GitHub Actions via Compute Contract Spindle

This walkthrough shows how to run a **GitHub Actions** workflow on a
[Tangled](https://tangled.org) repository using the **shared spindle**
(`*.gha.spindle.tangled.fedcicd.com`).

> A spindle is Tangled's CI runner. The shared spindle reads the standard
> `.github/workflows/*.yml` files in your repo and executes them through its
> policy engine. You are pushing a **GitHub Actions workflow**, not a native
> `.tangled/workflows` pipeline.

Each user gets their own shared-spindle hostname derived from their DID:

```
<your-did-with-colons-replaced-by-hyphens>.gha.spindle.tangled.fedcicd.com
```

For example, the DID `did:plc:lpfuqerea3deuoyrn7ojser4` becomes:

```
did-plc-lpfuqerea3deuoyrn7ojser4.gha.spindle.tangled.fedcicd.com
```

---

## 1. Register the spindle in your settings

Open **Settings → Spindles** (`https://tangled.org/settings/spindles`).

In **Register a spindle**, enter your shared-spindle hostname and click
**Register**.

![Enter the shared-spindle hostname](docs/images/usage/shared-spindle-gha/01-register-spindle-hostname.png)

The spindle is added to **Your spindles** in the `Unverified` state.

![Spindle registered, unverified](docs/images/usage/shared-spindle-gha/02-spindle-registered-unverified.png)

## 2. Verify the spindle

Click **Retry** (verify) next to the spindle. Tangled reaches the spindle's
`/xrpc/sh.tangled.owner` endpoint and confirms it is owned by your DID. Once it
succeeds the badge flips to `Verified`.

![Spindle verified](docs/images/usage/shared-spindle-gha/03-spindle-verified.png)

## 3. Point your repo at the spindle

Go to your repo's **Settings → Pipelines** tab
(`/<owner>/<repo>/settings?tab=pipelines`). In the **Spindle** dropdown, select
your shared-spindle hostname.

![Select the spindle for the repo](docs/images/usage/shared-spindle-gha/04-repo-select-spindle.png)

Save. Pipelines are now enabled for the repo (a **Secrets** section appears).

![Repo spindle saved](docs/images/usage/shared-spindle-gha/05-repo-spindle-saved.png)

## 4. Push the workflow (two files, same name)

You need **two** workflow files with the **same basename**:

- `.tangled/workflows/<name>.yml` — a native Tangled manifest. Its presence is
  what makes the knot's git post-receive hook emit the `sh.tangled.pipeline`
  event on push. **Without it the run never appears**, even with the spindle
  configured.
- `.github/workflows/<name>.yml` — the actual GitHub Actions workflow the shared
  spindle executes.

Clone over SSH and add both:

```bash
git clone git@tangled.org:<your-repo-did> repo
cd repo
mkdir -p .github/workflows .tangled/workflows
```

`.github/workflows/ci.yml` (what runs):

```yaml
# GitHub Actions workflow executed by the Tangled shared spindle.
name: CI
on: [push]
jobs:
  find:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: find .
```

`.tangled/workflows/ci.yml` (makes the knot emit the pipeline — same basename `ci`):

```yaml
when:
  - event: ["push", "manual"]
    branch: ["main"]

engine: "computeContractGHA"
```

Commit and push to the default branch:

```bash
git add .github/workflows/ci.yml .tangled/workflows/ci.yml
git commit -m "ci: run find . on shared spindle"
git push origin main
```

On push, the knot's post-receive hook records a `sh.tangled.pipeline` for the
commit (because `.tangled/workflows/ci.yml` exists). The shared spindle
(subscribed to the knot's event stream) sees your repo is authorized for it,
detects `.github/workflows`, and submits the matching GHA workflow to its policy
engine.

## 5. Watch it appear in Pipelines

Open the repo's **Pipelines** tab (`/<owner>/<repo>/pipelines`). The run for
your push appears and moves through `pending` → `running` → `succeeded`.

![Pipeline run listed](docs/images/usage/shared-spindle-gha/06-pipeline-run.png)

## 6. Check the pipeline logs

Open the run to read its console output. The `checkout` group shows the commit
checked out from the knot, and the `find .` step lists the workspace tree:

```
##[group]checkout
Checked out <sha> from https://knot1.tangled.sh
##[endgroup]
+ find .
.
./.github
./.github/workflows
./.github/workflows/ci.yml
./README.md
...
```

![Pipeline logs](docs/images/usage/shared-spindle-gha/07-pipeline-logs.png)

---

## How it works under the hood

The shared spindle (`tangled-spindle-minimal`) exposes:

| Route | Purpose |
|-------|---------|
| `GET /xrpc/sh.tangled.owner` | Owner DID — used during **Verify** |
| `GET /events` | Pipeline status WebSocket |
| `GET /logs/:knot/:pipelineRkey/:workflow` | Console output |
| `GET /status/:knot/:pipelineRkey/:workflow` | Run status JSON |

Flow on each push:

1. Knot's post-receive hook sees `.tangled/workflows/<name>.yml` and creates a
   `sh.tangled.pipeline` record. **This is the only path that produces the
   event** — no `.tangled` manifest, no pipeline.
2. Spindle (watching the knot event stream) discovers your repo is authorized
   (its configured spindle hostname matches the spindle's own hostname).
3. Spindle reads `.github/workflows/<name>.yml` at the pushed ref — the
   `.tangled` file's job is only to trigger; the **GHA file is what executes**.
4. Spindle submits the workflow to its policy engine and broadcasts status
   (`pending` → `running` → terminal) over `/events`.

> The two files must share a basename (e.g. both `ci.yml`): `.tangled/workflows`
> triggers the run, `.github/workflows` defines what runs.

### Gotchas seen in practice

- **Spindle must be stably connected when you push.** If the operator's spindle
  is restarting (e.g. `deno --watch` reacting to edits) the knot event can be
  missed with no replay — re-push once it's settled.
- **Authorize first.** The spindle only picks up repos it discovered *after* the
  repo's spindle field was set; pushes made before authorization won't run.
- **Vouch** You must be within 7 degress of vouchness of the operator to get
  jobs run. <https://blog.tangled.org/vouching/>
