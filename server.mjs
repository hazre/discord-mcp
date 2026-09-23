import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";

const WS_PORT = 7890;
const TIMEOUT_MS = 15000;

// ── WebSocket Bridge ─────────────────────────────────────────────────────────
let pluginSocket = null;
let pendingRequests = new Map(); // id -> { resolve, reject, timer, action, params }
let requestId = 0;

function isPermissionError(message) {
  return typeof message === "string" && message.includes("not-allowed:");
}

function toCuratedPermissionError(action, params, rawMessage) {
  const where = params?.channel_id || params?.guild_id || params?.user_id || "this scope";
  return `You are not allowed to do ${action} in ${where}. ${rawMessage} Check Vencord MCPBridge settings (allowedGuildIds, allowDMs, readonlyMode).`;
}

const wss = new WebSocketServer({ port: WS_PORT });

wss.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[bridge] Port ${WS_PORT} in use — killing old process and retrying...`);
    import("child_process").then(({ execSync }) => {
      try {
        const out = execSync(`netstat -ano | findstr :${WS_PORT}`, { encoding: "utf8" });
        const pid = out.trim().split(/\s+/).pop();
        if (pid && pid !== "0") execSync(`taskkill /F /PID ${pid}`);
        setTimeout(() => { wss.listen(WS_PORT); }, 500);
      } catch { console.error("[bridge] Could not recover — restart manually"); }
    });
  } else {
    console.error("[bridge] WebSocket error:", err.message);
  }
});

wss.on("connection", (ws) => {
  console.error("[bridge] Vencord plugin connected");
  pluginSocket = ws;

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const pending = pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(msg.id);
        if (msg.error) {
          if (isPermissionError(msg.error)) {
            pending.reject(new Error(toCuratedPermissionError(pending.action, pending.params, msg.error)));
          } else {
            pending.reject(new Error(msg.error));
          }
        } else {
          pending.resolve(msg.result);
        }
      }
    } catch (e) {
      console.error("[bridge] Bad message from plugin:", e.message);
    }
  });

  ws.on("close", () => {
    console.error("[bridge] Vencord plugin disconnected");
    pluginSocket = null;
    // Reject all pending requests
    for (const [id, p] of pendingRequests) {
      clearTimeout(p.timer);
      p.reject(new Error("Plugin disconnected"));
    }
    pendingRequests.clear();
  });
});

console.error(`[bridge] WebSocket server listening on ws://localhost:${WS_PORT}`);

function callPlugin(action, params = {}) {
  return new Promise((resolve, reject) => {
    if (!pluginSocket || pluginSocket.readyState !== 1) {
      return reject(new Error("Vencord plugin not connected. Open Discord with the MCP Bridge plugin enabled."));
    }

    const id = ++requestId;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timeout waiting for plugin response (action: ${action})`));
    }, TIMEOUT_MS);

    pendingRequests.set(id, { resolve, reject, timer, action, params });
    pluginSocket.send(JSON.stringify({ id, action, params }));
  });
}

function ok(text) {
  return { content: [{ type: "text", text: typeof text === "string" ? text : JSON.stringify(text, null, 2) }] };
}

function err(msg) {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

// ── MCP Server ───────────────────────────────────────────────────────────────
const mcp = new McpServer({ name: "discord-mcp", version: "1.0.0" });

// ── Guild / Server Tools ─────────────────────────────────────────────────────

mcp.tool(
  "list_guilds",
  "List all Discord servers (guilds) the user is in",
  {},
  async () => {
    try {
      return ok(await callPlugin("list_guilds"));
    } catch (e) { return err(e.message); }
  }
);

mcp.tool(
  "get_guild_info",
  "Get detailed info about a specific guild",
  { guild_id: z.string().describe("The guild/server ID") },
  async ({ guild_id }) => {
    try {
      return ok(await callPlugin("get_guild_info", { guild_id }));
    } catch (e) { return err(e.message); }
  }
);

// ── Channel Tools ────────────────────────────────────────────────────────────

mcp.tool(
  "list_channels",
  "List all channels in a guild",
  {
    guild_id: z.string().describe("The guild/server ID"),
    type: z.string().optional().describe("Filter by type: text, voice, category, announcement, forum")
  },
  async ({ guild_id, type }) => {
    try {
      return ok(await callPlugin("list_channels", { guild_id, type }));
    } catch (e) { return err(e.message); }
  }
);

mcp.tool(
  "get_channel_info",
  "Get detailed info about a specific channel",
  { channel_id: z.string().describe("The channel ID") },
  async ({ channel_id }) => {
    try {
      return ok(await callPlugin("get_channel_info", { channel_id }));
    } catch (e) { return err(e.message); }
  }
);

// ── Message Tools ────────────────────────────────────────────────────────────

mcp.tool(
  "send_message",
  "Send a message to a Discord channel",
  {
    channel_id: z.string().describe("The channel ID to send the message to"),
    content: z.string().describe("The message content"),
    tts: z.boolean().optional().describe("Whether to send as text-to-speech"),
    reply_to: z.string().optional().describe("Message ID to reply to")
  },
  async ({ channel_id, content, tts, reply_to }) => {
    try {
      return ok(await callPlugin("send_message", { channel_id, content, tts, reply_to }));
    } catch (e) { return err(e.message); }
  }
);

mcp.tool(
  "edit_message",
  "Edit one of your own messages",
  {
    channel_id: z.string().describe("The channel ID"),
    message_id: z.string().describe("The message ID to edit"),
    content: z.string().describe("The new message content")
  },
  async ({ channel_id, message_id, content }) => {
    try {
      return ok(await callPlugin("edit_message", { channel_id, message_id, content }));
    } catch (e) { return err(e.message); }
  }
);

mcp.tool(
  "delete_message",
  "Delete a message",
  {
    channel_id: z.string().describe("The channel ID"),
    message_id: z.string().describe("The message ID to delete")
  },
  async ({ channel_id, message_id }) => {
    try {
      return ok(await callPlugin("delete_message", { channel_id, message_id }));
    } catch (e) { return err(e.message); }
  }
);

mcp.tool(
  "read_messages",
  "Read recent messages from a channel",
  {
    channel_id: z.string().describe("The channel ID to read from"),
    limit: z.number().optional().describe("Number of messages to fetch (default 50, max 100)")
  },
  async ({ channel_id, limit }) => {
    try {
      return ok(await callPlugin("read_messages", { channel_id, limit: limit || 50 }));
    } catch (e) { return err(e.message); }
  }
);

mcp.tool(
  "search_messages",
  "Search messages in a guild or channel",
  {
    guild_id: z.string().optional().describe("Guild to search in"),
    channel_id: z.string().optional().describe("Channel to search in (narrows guild search)"),
    query: z.string().describe("Search query text"),
    author_id: z.string().optional().describe("Filter by author ID"),
    limit: z.number().optional().describe("Max results (default 25)")
  },
  async (params) => {
    try {
      return ok(await callPlugin("search_messages", params));
    } catch (e) { return err(e.message); }
  }
);

// ── Reaction Tools ───────────────────────────────────────────────────────────

mcp.tool(
  "add_reaction",
  "Add a reaction to a message",
  {
    channel_id: z.string().describe("The channel ID"),
    message_id: z.string().describe("The message ID"),
    emoji: z.string().describe("The emoji to react with (e.g. '👍' or 'custom_emoji:123456')")
  },
  async ({ channel_id, message_id, emoji }) => {
    try {
      return ok(await callPlugin("add_reaction", { channel_id, message_id, emoji }));
    } catch (e) { return err(e.message); }
  }
);

mcp.tool(
  "remove_reaction",
  "Remove your reaction from a message",
  {
    channel_id: z.string().describe("The channel ID"),
    message_id: z.string().describe("The message ID"),
    emoji: z.string().describe("The emoji to remove")
  },
  async ({ channel_id, message_id, emoji }) => {
    try {
      return ok(await callPlugin("remove_reaction", { channel_id, message_id, emoji }));
    } catch (e) { return err(e.message); }
  }
);

// ── User Tools ───────────────────────────────────────────────────────────────

mcp.tool(
  "get_current_user",
  "Get info about the currently logged-in Discord user",
  {},
  async () => {
    try {
      return ok(await callPlugin("get_current_user"));
    } catch (e) { return err(e.message); }
  }
);

mcp.tool(
  "get_user_info",
  "Get info about a specific user by ID",
  { user_id: z.string().describe("The user ID") },
  async ({ user_id }) => {
    try {
      return ok(await callPlugin("get_user_info", { user_id }));
    } catch (e) { return err(e.message); }
  }
);

mcp.tool(
  "list_guild_members",
  "List members of a guild (fetches from member list)",
  {
    guild_id: z.string().describe("The guild ID"),
    limit: z.number().optional().describe("Max members to return (default 100)")
  },
  async ({ guild_id, limit }) => {
    try {
      return ok(await callPlugin("list_guild_members", { guild_id, limit: limit || 100 }));
    } catch (e) { return err(e.message); }
  }
);

// ── DM Tools ─────────────────────────────────────────────────────────────────

mcp.tool(
  "list_dms",
  "List all open DM conversations",
  {},
  async () => {
    try {
      return ok(await callPlugin("list_dms"));
    } catch (e) { return err(e.message); }
  }
);

mcp.tool(
  "send_dm",
  "Send a direct message to a user",
  {
    user_id: z.string().describe("The user ID to DM"),
    content: z.string().describe("The message content")
  },
  async ({ user_id, content }) => {
    try {
      return ok(await callPlugin("send_dm", { user_id, content }));
    } catch (e) { return err(e.message); }
  }
);

// ── Status / Presence Tools ──────────────────────────────────────────────────

mcp.tool(
  "set_status",
  "Set user's custom status",
  {
    text: z.string().optional().describe("Custom status text"),
    emoji: z.string().optional().describe("Status emoji"),
    status: z.string().optional().describe("online, idle, dnd, or invisible")
  },
  async (params) => {
    try {
      return ok(await callPlugin("set_status", params));
    } catch (e) { return err(e.message); }
  }
);

// ── Voice Tools ──────────────────────────────────────────────────────────────

mcp.tool(
  "join_voice",
  "Join a voice channel",
  {
    channel_id: z.string().describe("The voice channel ID to join"),
    guild_id: z.string().describe("The guild ID"),
    self_mute: z.boolean().optional().describe("Join muted (default false)"),
    self_deaf: z.boolean().optional().describe("Join deafened (default false)")
  },
  async (params) => {
    try {
      return ok(await callPlugin("join_voice", params));
    } catch (e) { return err(e.message); }
  }
);

mcp.tool(
  "leave_voice",
  "Leave the current voice channel",
  {},
  async () => {
    try {
      return ok(await callPlugin("leave_voice"));
    } catch (e) { return err(e.message); }
  }
);

// ── Role Tools ───────────────────────────────────────────────────────────────

mcp.tool(
  "list_roles",
  "List all roles in a guild",
  { guild_id: z.string().describe("The guild ID") },
  async ({ guild_id }) => {
    try {
      return ok(await callPlugin("list_roles", { guild_id }));
    } catch (e) { return err(e.message); }
  }
);

// ── Channel Management ──────────────────────────────────────────────────────

mcp.tool(
  "create_channel",
  "Create a new channel in a guild",
  {
    guild_id: z.string().describe("The guild ID"),
    name: z.string().describe("Channel name"),
    type: z.string().optional().describe("Channel type: text (default), voice, category, announcement, forum"),
    parent_id: z.string().optional().describe("Parent category ID"),
    topic: z.string().optional().describe("Channel topic/description")
  },
  async (params) => {
    try {
      return ok(await callPlugin("create_channel", params));
    } catch (e) { return err(e.message); }
  }
);

mcp.tool(
  "delete_channel",
  "Delete a channel",
  { channel_id: z.string().describe("The channel ID to delete") },
  async ({ channel_id }) => {
    try {
      return ok(await callPlugin("delete_channel", { channel_id }));
    } catch (e) { return err(e.message); }
  }
);

// ── Thread Tools ─────────────────────────────────────────────────────────────

mcp.tool(
  "create_thread",
  "Create a thread from a message or in a channel",
  {
    channel_id: z.string().describe("The channel ID"),
    name: z.string().describe("Thread name"),
    message_id: z.string().optional().describe("Message ID to start thread from (omit for forum/standalone thread)"),
    auto_archive_duration: z.number().optional().describe("Auto archive in minutes: 60, 1440, 4320, 10080")
  },
  async (params) => {
    try {
      return ok(await callPlugin("create_thread", params));
    } catch (e) { return err(e.message); }
  }
);

// ── Typing Indicator ─────────────────────────────────────────────────────────

mcp.tool(
  "start_typing",
  "Show typing indicator in a channel",
  { channel_id: z.string().describe("The channel ID") },
  async ({ channel_id }) => {
    try {
      return ok(await callPlugin("start_typing", { channel_id }));
    } catch (e) { return err(e.message); }
  }
);

// ── Pin Tools ────────────────────────────────────────────────────────────────

mcp.tool(
  "pin_message",
  "Pin a message in a channel",
  {
    channel_id: z.string().describe("The channel ID"),
    message_id: z.string().describe("The message ID to pin")
  },
  async ({ channel_id, message_id }) => {
    try {
      return ok(await callPlugin("pin_message", { channel_id, message_id }));
    } catch (e) { return err(e.message); }
  }
);

mcp.tool(
  "unpin_message",
  "Unpin a message",
  {
    channel_id: z.string().describe("The channel ID"),
    message_id: z.string().describe("The message ID to unpin")
  },
  async ({ channel_id, message_id }) => {
    try {
      return ok(await callPlugin("unpin_message", { channel_id, message_id }));
    } catch (e) { return err(e.message); }
  }
);

// ── Nickname ─────────────────────────────────────────────────────────────────

mcp.tool(
  "set_nickname",
  "Set your nickname in a guild",
  {
    guild_id: z.string().describe("The guild ID"),
    nickname: z.string().describe("The new nickname (empty string to reset)")
  },
  async ({ guild_id, nickname }) => {
    try {
      return ok(await callPlugin("set_nickname", { guild_id, nickname }));
    } catch (e) { return err(e.message); }
  }
);

// ── Connection Status ────────────────────────────────────────────────────────

mcp.tool(
  "connection_status",
  "Check if the Vencord bridge plugin is connected",
  {},
  async () => {
    if (pluginSocket && pluginSocket.readyState === 1) {
      return ok("Vencord bridge plugin is connected and ready.");
    }
    return err("Vencord bridge plugin is NOT connected. Make sure Discord is open with the MCPBridge plugin enabled.");
  }
);

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await mcp.connect(transport);
console.error("[mcp] Discord MCP server running");
