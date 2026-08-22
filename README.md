# NexusSQL

A real MySQL/MariaDB desktop client built with Electron. Connects to actual local or remote databases.

## Requirements

- [Node.js](https://nodejs.org/) v18 or higher (includes npm)

## Quick Start

```bash
# 1. Open a terminal inside the nexussql folder
cd nexussql

# 2. Install dependencies (Electron + mysql2 driver)
npm install

# 3. Launch
npm start
```

## Connecting to a Database

Click **"+ Connection"** in the top toolbar and fill in:

| Field    | Description                                      |
|----------|--------------------------------------------------|
| Name     | A friendly label (e.g. "Local Dev")              |
| Host     | `127.0.0.1` for local, or a remote IP/hostname   |
| Port     | Default MySQL port is `3306`                     |
| User     | Your MySQL username (e.g. `root`)                |
| Password | Leave blank if no password set                   |
| Database | Optional — leave blank to browse all databases   |
| SSL      | Check if your remote server requires SSL         |

Click **Test Connection** to verify before saving.

## Features

- Real MySQL/MariaDB connectivity (local and remote)
- Live database + table browser in the sidebar
- Column inspector (click the arrow next to any table)
- Double-click a table to auto-run `SELECT * FROM table LIMIT 1000`
- Multi-tab query editor with line numbers
- Ctrl+Enter to run, Ctrl+T for new tab, Ctrl+S to save
- Sortable results grid
- CSV export via native save dialog
- Query history
- AI assistant (see below)

## AI Assistant (Optional)

The built-in assistant works with either **Anthropic (Claude)** or **OpenAI (GPT)**.

Open the app, click the **gear icon** in the AI panel header, pick a provider and
paste your API key. That's it — no files to edit.

Keys are encrypted at rest with your OS keychain (Windows DPAPI / macOS Keychain)
and stored in `settings.json` under your user-data folder, well outside this
repository. They are never written to disk in plain text and never belong in the
source tree.

Get keys at https://console.anthropic.com or https://platform.openai.com

The assistant can run read-only queries on its own and propose single-cell or
single-row edits, which you approve before anything is written. API usage is
billed by the provider.

## Local MCP Server (Optional)

NexusSQL can expose its databases to an external AI — Claude Code, Claude Desktop,
a local agent — over MCP. Click **🔌 MCP** in the title bar to configure which
connections it may use, what it is permitted to do, whether each action needs your
confirmation, and which tables are off limits.

The server binds to `127.0.0.1` only and requires a bearer token, which the panel
generates and bakes into a copy-paste connect command.

## Build an Installer

```bash
# Windows
npm run build-win

# macOS
npm run build-mac

# Linux
npm run build-linux
```

Output goes to the `dist/` folder.

## Project Structure

```
nexussql/
├── main.js        — Electron main process, MySQL IPC handlers
├── preload.js     — Secure bridge (contextBridge)
├── package.json
└── src/
    ├── index.html
    ├── style.css
    └── app.js     — All UI logic and DB interaction
```
