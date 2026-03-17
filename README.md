# Discord MCP Server

A full-featured [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that lets AI agents (Claude, etc.) interact with Discord — send messages, read channels, manage servers, join voice, and more.

Works by bridging an MCP stdio server with a [Vencord](https://vencord.dev) plugin running inside Discord. The plugin hooks into Discord's internal APIs, giving the MCP server full access to anything your Discord account can do.

```
AI Agent <--stdio--> MCP Server <--WebSocket--> Vencord Plugin <--> Discord
```

## Features

**26 tools** available to any MCP-compatible AI agent:

| Category | Tools |
|---|---|
| **Servers** | `list_guilds`, `get_guild_info` |
| **Channels** | `list_channels`, `get_channel_info`, `create_channel`, `delete_channel` |
| **Messages** | `send_message`, `edit_message`, `delete_message`, `read_messages`, `search_messages` |
| **DMs** | `list_dms`, `send_dm` |
| **Reactions** | `add_reaction`, `remove_reaction` |
| **Threads** | `create_thread` |
| **Users** | `get_current_user`, `get_user_info`, `list_guild_members` |
| **Voice** | `join_voice`, `leave_voice` |
| **Roles** | `list_roles` |
| **Status** | `set_status`, `set_nickname` |
| **Pins** | `pin_message`, `unpin_message` |
| **Utility** | `start_typing`, `connection_status` |

## Prerequisites

- [Node.js](https://nodejs.org) v18+
- [pnpm](https://pnpm.io) (`npm i -g pnpm`)
- [Git](https://git-scm.com)
- Discord desktop app
- An MCP-compatible client (e.g. [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Claude Desktop](https://claude.ai/download))

## Installation

### 1. Clone this repo

```bash
git clone https://github.com/YOUR_USERNAME/discord-mcp.git
cd discord-mcp
npm install
```

### 2. Install the Vencord plugin

The plugin is **not** in Vencord's official plugin registry — it's a userplugin you build from source.

#### If you already have Vencord from source:

```bash
# Copy the plugin into your Vencord source tree
cp -r vencord-plugin /path/to/vencord/src/userplugins/MCPBridge
```

#### If you don't have Vencord yet:

```bash
# Clone Vencord
git clone https://github.com/Vendicated/Vencord.git
cd Vencord

# Install dependencies
pnpm install

# Copy the plugin
cp -r /path/to/discord-mcp/vencord-plugin src/userplugins/MCPBridge

# Build Vencord (includes your plugin)
pnpm build

# Inject into Discord
pnpm inject
```

> **Note:** `pnpm inject` will ask you to select your Discord installation. After injection, restart Discord.

#### If Vencord is already injected (just updating the plugin):

```bash
# Rebuild Vencord after adding/updating the plugin
cd /path/to/Vencord
pnpm build

# Copy the built files to Vencord's dist folder
# Windows:
copy dist\*.js %APPDATA%\Vencord\dist\

# macOS/Linux:
cp dist/*.js ~/.config/Vencord/dist/
```

Then restart Discord (Ctrl+R or Cmd+R).

### 3. Enable the plugin in Discord

1. Open Discord
2. Go to **User Settings** (gear icon) > **Vencord** > **Plugins**
3. Search for **MCPBridge**
4. Toggle it **ON**
5. You should see `[MCPBridge] Connected to MCP server` in the console (Ctrl+Shift+I)

### 4. Configure your MCP client

#### Claude Code

Add to your `.claude.json` (in your project or home directory):

```json
{
  "mcpServers": {
    "discord": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/discord-mcp/server.mjs"]
    }
  }
}
```

Or create a `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["/path/to/discord-mcp/server.mjs"]
    }
  }
}
```

#### Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["/path/to/discord-mcp/server.mjs"]
    }
  }
}
```

### 5. Verify it works

In Claude Code, run `/mcp` — you should see the `discord` server listed with all tools. Then try:

> "Check the Discord connection status"

or

> "List my Discord servers"

## How It Works

```
                    stdio (JSON-RPC)              WebSocket (:7890)
Claude Code  <──────────────────────>  server.mjs  <──────────────>  Vencord Plugin
  (MCP Client)                        (MCP Server)                   (runs inside Discord)
                                                                          │
                                                                     Discord Internal APIs
                                                                     (RestAPI, GuildStore,
                                                                      ChannelStore, etc.)
```

1. **server.mjs** — Node.js process that exposes MCP tools over stdio and runs a WebSocket server on port `7890`
2. **Vencord MCPBridge plugin** — Runs inside Discord's renderer process, connects to the WebSocket, and executes actions using Discord's internal webpack modules
3. When an AI agent calls an MCP tool (e.g. `send_message`), the server forwards it over WebSocket to the plugin, which calls the Discord API and returns the result

The plugin auto-reconnects every 5 seconds if the MCP server isn't running, so you can start them in any order.

## Project Structure

```
discord-mcp/
├── server.mjs          # MCP server + WebSocket bridge
├── package.json        # Node.js dependencies
├── vencord-plugin/
│   └── index.tsx       # Vencord userplugin (MCPBridge)
└── README.md
```

## Configuration

| Setting | Default | Description |
|---|---|---|
| WebSocket port | `7890` | Change `WS_PORT` in `server.mjs` and `WS_URL` in `vencord-plugin/index.tsx` |
| Request timeout | `15000` ms | Change `TIMEOUT_MS` in `server.mjs` |
| Reconnect interval | `5000` ms | Change `RECONNECT_INTERVAL` in `vencord-plugin/index.tsx` |

## Troubleshooting

### Plugin won't connect
- Make sure the MCP server is running (`node server.mjs`)
- Check Discord console (Ctrl+Shift+I) for `[MCPBridge]` logs
- The plugin connects to `ws://127.0.0.1:7890` (not `localhost` — Discord's CSP blocks `localhost`)

### Port 7890 already in use
The server automatically detects this and kills the stale process. If it can't recover:
```bash
# Windows
netstat -ano | findstr :7890
taskkill /F /PID <pid>

# macOS/Linux
lsof -i :7890
kill -9 <pid>
```

### MCP tools not showing up
- Restart your MCP client after adding the config
- Make sure the path to `server.mjs` is absolute
- Check that `node` is in your PATH

### "Vencord plugin not connected" error
- Open Discord with the MCPBridge plugin enabled
- Wait a few seconds for the WebSocket connection to establish
- Use the `connection_status` tool to verify

## Security Considerations

- This runs with **your Discord account's full permissions** — the AI can do anything you can do
- The WebSocket only listens on `127.0.0.1` (localhost) — not exposed to the network
- Review tool calls before approving them, especially destructive actions like `delete_message` or `delete_channel`
- The MCP server does NOT store your Discord token — it communicates through Discord's own internal APIs via the Vencord plugin

## License

MIT
