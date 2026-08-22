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

The AI assistant uses the Anthropic Claude API.
To enable it, open `src/app.js` and find this line near the top of `sendAI()`:

```js
'x-api-key': window.ANTHROPIC_API_KEY || '',
```

Set your key by adding this line at the **very top** of `src/app.js`:

```js
window.ANTHROPIC_API_KEY = 'sk-ant-YOUR_KEY_HERE';
```

Get a key at https://console.anthropic.com

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
