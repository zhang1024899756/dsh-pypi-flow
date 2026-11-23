# dsh-pypi-flow

[简体中文](README.zh.md) | English

PyPI workflow for DeepSeek Harness: query packages and releases, check name availability, publish distributions, manage account credentials, and keep a list of your own projects — with a settings panel under **Settings → PyPI**.

**Zero runtime dependencies. No build step.** Queries ride PyPI's public JSON API; publishing constructs the official `multipart/form-data` upload request directly. **No local Python, no twine, no pip required.**

---

## What this plugin will not pretend to do

Four facts about PyPI, verified against the live service, that shape the feature set:

| You may want | Reality | What this plugin does |
|---|---|---|
| Delete a release or file | PyPI has **no delete API**; it is a website-only action ([warehouse#12934](https://github.com/pypi/warehouse/issues/12934) is still open) | `pypi_delete_guide` returns the rules plus a direct manage-page link, and does not pretend to perform it |
| Delete a whole project | **Not supported.** PyPI retains the name under PEP 541 | Same: you can only remove all of its releases; the name stays taken |
| Yank a release | **No API**; the programmatic-yanking pull request is unmerged | Points at the manage page checkbox, which is the better alternative to deleting |
| List every package this account owns | The user page sits behind a JavaScript bot challenge | Maintains a local tracked list and verifies each entry through `ownership` |

Two more things worth knowing:

- **An API token cannot be verified offline.** PyPI tokens only work against the upload API, and a bad token, a missing token, and insufficient permission all answer with the same `403`. `pypi_probe_token` sends an upload request that carries no file and reports what that reveals — an inference from the endpoint's behaviour, not an official verification. The first real upload remains the authoritative check.
- **"Name is free" is not "name is registrable."** PyPI reserves names, so `pypi_check_name` reports current occupancy only.

---

## Install

### From npm (recommended)

Published on the public npm registry, so DSH resolves it by package name:

```
dsh plugin add dsh-pypi-flow
```

The same name works in the Plugin Manager's "add plugin" box. Current version: `0.1.1`.

### From the plugin market

This repository ships a format-1 plugin market index:

```
https://raw.githubusercontent.com/zhang1024899756/dsh-pypi-flow/main/market/index.json
```

Add it as an index source on DSH's **Discover** page and "PyPI workflow" shows up there, installable in one click.

> DSH has no public official index — Discover lists only the sources you add yourself, so this step is required.

### From GitHub

In DSH:

```
/plugin add github:zhang1024899756/dsh-pypi-flow
```

Or from a shell:

```bash
dsh plugin --profile web add github:zhang1024899756/dsh-pypi-flow
```

### Regenerating the market index

After changing the manifest or display metadata (`locale/`, `icon.svg`), refresh the index with the official generator from a DSH source checkout:

```bash
# run from the checkout root
echo "https://github.com/zhang1024899756/dsh-pypi-flow" > plugins.txt
pnpm --filter @deepseek-ai/dsh-plugin-market-generator start \
  --input plugins.txt --output market/index.json --title "Arvin DSH plugins"
```

The generator validates every entry with `dsh-plugin-market-index` and inlines icons as `data:` URLs when small enough.

---

## The settings panel

**Settings → PyPI** has four sections:

1. **Account binding** — PyPI username plus API token. The token is written only to the local DSH credential store (`$DSH_HOME/.credentials.yaml`); the panel shows a mask such as `pypi-A****c9a1` and never the value.
2. **My projects** — the tracked list, each row showing its latest version, last upload, file count, and whether `ownership` includes the bound username. A successful publish adds a row automatically.
3. **Package lookup** — type a name, get the project's current state.
4. **Notes** — where the token goes, why a project-scoped token is better, and why a token cannot be pre-verified.

### Creating a token

Open <https://pypi.org/manage/account/token/> and scope the token to **specific projects** rather than the whole account. A project-scoped token can only publish to those projects, which bounds the damage if it leaks.

---

## Tools

| Tool | Purpose |
|---|---|
| `pypi_status` | Binding state, masked token, tracked-project count, last publish |
| `pypi_config` | Bind a username, save/clear a token (persisted or session-only), set the default target, add/remove tracked projects |
| `pypi_info` | Project detail: latest version, summary, requires_python, ownership, release count, last upload, yank state |
| `pypi_versions` | Release history, newest first, with file counts and yank state |
| `pypi_check_name` | Name validity plus current occupancy |
| `pypi_my_packages` | The tracked list, live-queried, with ownership verification |
| `pypi_publish` | Upload `.whl` / `.tar.gz` to PyPI or TestPyPI |
| `pypi_probe_token` | File-less connectivity probe against the upload endpoint |
| `pypi_delete_guide` | The real delete / yank path with direct links |

### Publishing

```text
pypi_publish { path: "D:/proj/dist", dryRun: true }     # pre-flight: parse metadata, build the request, send nothing
pypi_publish { path: "D:/proj/dist" }                   # real upload
pypi_publish { path: "D:/proj", build: true }           # run python -m build first
pypi_publish { path: "D:/proj/dist", repository: "testpypi" }
```

`path` accepts a single file or a directory (every distribution inside it is uploaded).

**Publishing is irreversible.** A version number cannot be reused, not even after its files are deleted. So check `pypi_info` for an occupied version, then `dryRun`, then publish.

### Building

`build: true` runs `python -m build --outdir dist` in the project directory. That path needs Python and the `build` module (`pip install build`). Pointing `path` at an existing `dist/` needs neither.

---

## Credential safety

- The token lives in the DSH credential service — not in configuration, not in this plugin's state file, not in the conversation.
- `$DSH_HOME/pypi-flow.json` holds only the username, the tracked list, and the last publish receipt; mode 0600, **no secret**.
- Every tool result, route response, and log line is checked: no token plaintext.
- You can avoid persistence entirely: `pypi_config`'s `sessionToken` stays in memory and dies with the process.

---

## Development

No build step, so editing a file takes effect immediately (with a local link install).

```bash
node tests/smoke.mjs      # host suite + uploader suite, fully offline
node --check index.js     # syntax
```

Layout:

```
index.js            host entry: mounts tools / routes / prompt section
lib/store.js        account state + credentials (credential service + 0600 state file)
lib/pypi.js         JSON API client, PEP 503 names, ownership, token probe
lib/metadata.js     wheel / sdist metadata (own zip and tar readers)
lib/upload.js       zero-dependency multipart uploader
lib/tools.js        the nine model-facing tools
lib/routes.js       loopback HTTP routes for the panel
client.js           settings panel (browser module, React.createElement)
```

Design notes: ownership is what backs the "my packages" claim; every name comparison goes through `normalizeProjectName()`; upload form fields follow the official lower-case / underscore / pluralization rule plus its three exceptions (`platform`, `supported_platform`, `license_file`).

---

## License

MIT
