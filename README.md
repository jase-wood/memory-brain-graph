# Memory Brain Graph

A self-hosted 3D knowledge graph visualiser for Obsidian vaults, with an MCP server so your AI assistant can read and write notes directly.

![3D force-directed graph with galaxy background, coloured nodes by type, glowing synapse particles](https://placeholder-screenshot.png)
<!-- Replace with a real screenshot once you have one -->

---

## What it is

- **Live 3D graph** of your entire Obsidian vault rendered in-browser using [3d-force-graph](https://github.com/vasturiano/3d-force-graph)
- **Node types** — notes and folders are colour-coded by their top-level folder (projects, ideas, people, tools, etc.)
- **Solar system layout** — person nodes act as suns; everything else orbits in shells by connection distance
- **Neural synapses** — particle cascades spontaneously fire across connections to give the graph a living feel
- **Synapse brightness slider** — 0–10 control for link visibility in the bottom-right corner
- **Search** — live node filtering with camera fly-to on Enter
- **MCP server** — exposes `read_note`, `write_note`, `list_notes`, `search_notes` tools over SSE so Claude (or any MCP client) can interact with your vault
- **Optional Electron app** — packages the viewer as a standalone Windows desktop app with offline error handling and auto-reconnect

---

## Architecture

```
Your Obsidian Vault (markdown files)
         │
         ▼
┌─────────────────────────────┐
│   Node.js server            │  port 3000
│   mcp/index.js              │──────────────► MCP client (Claude Desktop, etc.)
│   - /graph  (JSON data API) │
│   - /sse    (MCP over SSE)  │
└─────────────────────────────┘
         │  fetches /graph
         ▼
┌─────────────────────────────┐
│   graph.html                │  port 8080  (served by `npx serve`)
│   3D force graph + galaxy   │◄──────────── Browser  /  Electron app
└─────────────────────────────┘
         ▲
         │  config.json (host/port)
┌─────────────────────────────┐
│   Electron desktop app      │  Windows — optional, wraps the web UI
│   electron-app/             │
└─────────────────────────────┘
```

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Linux server** | Any machine on your network — bare metal, VM, LXC container, Raspberry Pi, VPS |
| **Node.js 18+** | `node --version` to check |
| **npm** | Comes with Node |
| **An Obsidian vault** | Folder-based structure (see [Vault structure](#vault-structure) below) |

For the optional Electron app:
- Windows 10/11
- Node.js on the build machine

---

## Server setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/memory-brain-graph.git
cd memory-brain-graph/server
npm install
```

### 2. Configure the vault path

The server reads from an environment variable:

```bash
export VAULT_PATH=/path/to/your/obsidian-vault
```

Or create a `.env` file in `server/`:

```
VAULT_PATH=/path/to/your/obsidian-vault
```

> **Tip:** If your vault is synced (Syncthing, Dropbox, iCloud Drive, etc.) point `VAULT_PATH` at the synced copy on your server.

### 3. Adjust the folder → node type mapping

Open `server/index.js` and find `typeMap`. Edit it to match your vault's top-level folders:

```js
const typeMap = {
  '00 - Inbox':              'memory',
  '01 - Projects':           'project',
  '02 - Areas':              'topic',
  '05 - People':             'person',   // ← person nodes become "suns"
  '06 - Ideas':              'idea',
  // add or rename to match your folder names
};
```

Available types and their colours: `memory` `project` `topic` `idea` `person` `client` `tool` `learning` `infra` `script` `task`

### 4. Start the MCP / data server

```bash
node index.js
# Listening on port 3000
```

### 5. Serve graph.html

The graph UI is a single static file. Serve it with any static file server:

```bash
cd ..                          # repo root
npx serve . -p 8080
```

Or copy `graph.html` to any web server's document root.

Open `http://localhost:8080/graph.html` in a browser — you should see the graph loading.

---

## Systemd (auto-start on Linux)

Copy the unit files, then edit them to set your username and paths:

```bash
cp systemd/*.service /etc/systemd/system/
# edit both files: replace YOUR_USER and /path/to/repo
nano /etc/systemd/system/memory-brain-mcp.service
nano /etc/systemd/system/memory-brain-graph.service

systemctl daemon-reload
systemctl enable --now memory-brain-mcp.service
systemctl enable --now memory-brain-graph.service
```

---

## Electron desktop app (Windows, optional)

The Electron app wraps the web UI in a native window. It probes your server on launch and shows an offline page with a retry button if the server is unreachable.

### Development

```bash
cd electron-app
npm install
cp config.example.json config.json
# edit config.json — set hosts to your server's IP(s)
npm start
```

### Build a portable .exe or installer

```bash
npm run pack:portable    # single .exe, no install needed
npm run pack:installer   # NSIS installer
npm run pack:both        # both
```

Output lands in `electron-app/dist/`.

### config.json

| Field | Description |
|---|---|
| `hosts` | Array of IPs/hostnames to try in order (useful for LAN + VPN fallback) |
| `port` | Port serving `graph.html` (default: `8080`) |
| `dataPort` | Port serving the data API (default: `3000`) |
| `probePath` | Health-check path on the data API (default: `/graph`) |
| `windowTitle` | Title bar text |
| `probeTimeoutMs` | How long to wait before declaring a host unreachable |

---

## MCP integration (Claude Desktop)

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "memory-brain": {
      "command": "npx",
      "args": [
        "mcp-remote@0.1.38",
        "http://YOUR_SERVER_IP:3000/sse",
        "--allow-http"
      ]
    }
  }
}
```

> **Note:** `--allow-http` is required for non-localhost HTTP URLs. Pin the `mcp-remote` version (e.g. `0.1.38`) to avoid silent breaking updates.

This exposes four tools to the AI:

| Tool | Description |
|---|---|
| `read_note` | Read a note by vault-relative path |
| `write_note` | Create or overwrite a note |
| `list_notes` | List all `.md` files, optionally scoped to a folder |
| `search_notes` | Full-text search across all notes |

---

## Vault structure

The server expects an Obsidian vault with numbered top-level folders (the [PARA method](https://fortelabs.com/blog/para/) works well, but any structure is fine as long as you update `typeMap`).

Example structure:
```
vault/
├── 00 - Inbox/
├── 01 - Projects/
├── 02 - Areas/
├── 03 - Resources/
├── 04 - Daily Notes/
├── 05 - People/          ← nodes here become "suns" in the solar layout
├── 06 - Ideas/
├── 07 - Archive/
├── 08 - Clients/
├── 09 - Tools/
├── 10 - Learning/
├── 11 - Infrastructure/
├── 12 - Scripts & Snippets/
└── 13 - Tasks/
```

Wiki-links (`[[Note Name]]`) in note content become graph edges automatically.

---

## Customisation

### Node colours

Edit the `C` object near the top of `graph.html`:

```js
const C = {
  memory:   '#7dd8ff',
  project:  '#ffd080',
  topic:    '#72e8c4',
  idea:     '#cc78ff',
  person:   '#ffe680',   // also used as the "sun" glow colour
  // ...
};
```

### Synapse behaviour

```js
const SYNAPSE = {
  interval: 1300,   // ms between spontaneous cascade firings
  fanout:   0.6,    // probability a link lights up when its node fires
  spread:   0.4,    // probability the cascade continues to a neighbour
  maxDepth: 3,      // maximum cascade hops
};
```

### Node sizes

```js
.nodeVal(n =>
  n.id === PEOPLE_CORE ? 110 :   // the central hub
  n.isFolder          ? 30  :   // top-level folder nodes
  n.type === 'person' ? 48  :   // person (sun) nodes
  (n.r || 4)                    // everything else
)
```

### Synapse brightness slider

The slider in the bottom-right corner (labelled **Synapse**, 0–10) controls link line opacity at runtime:
- `0` = links invisible
- `10` = links as bright as nodes (opacity 0.85)

The default on load is `2`.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Loading vault…" never clears | Server on port 3000 is not running or unreachable — check `systemctl status memory-brain-mcp` |
| Electron app shows offline page | Server IP in `config.json` is wrong, or server is down |
| Graph loads but has no links | Wiki-links in your vault use a format the regex doesn't match — check note content |
| MCP tools not appearing in Claude | Missing `--allow-http` flag, or wrong port |

---

## Stack

| Component | Library / tool |
|---|---|
| 3D graph | [3d-force-graph](https://github.com/vasturiano/3d-force-graph) |
| Galaxy background | Canvas 2D API (no extra library) |
| MCP server | [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) |
| HTTP server | [Express](https://expressjs.com/) |
| Static file server | [serve](https://github.com/vercel/serve) |
| Desktop app | [Electron](https://www.electronjs.org/) + [electron-builder](https://www.electron.build/) |

---

## Licence

MIT
