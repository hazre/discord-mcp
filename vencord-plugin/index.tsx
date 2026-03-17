/*
 * Vencord MCP Bridge Plugin
 * Connects to the MCP server's WebSocket and executes Discord actions.
 * Drop this folder into Vencord's src/userplugins/MCPBridge/
 */

import definePlugin from "@utils/types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { FluxDispatcher, RestAPI, UserStore, ChannelStore, GuildStore } from "@webpack/common";

// ── Discord Internal Modules (lazy-loaded from webpack) ──────────────────────

const MessageActions = findByPropsLazy("sendMessage", "editMessage", "deleteMessage");
const TypingActions = findByPropsLazy("startTyping");
const VoiceActions = findByPropsLazy("selectVoiceChannel");
const PresenceStore = findStoreLazy("PresenceStore");
const DMChannelStore = findByPropsLazy("getPrivateChannelIds");
const ReactionActions = findByPropsLazy("addReaction", "removeReaction");

// ── WebSocket Connection ─────────────────────────────────────────────────────

const WS_URL = "ws://127.0.0.1:7890";
const RECONNECT_INTERVAL = 5000;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let enabled = false;

function connect() {
    if (!enabled) return;
    if (ws && ws.readyState <= 1) return; // already connected or connecting

    try {
        ws = new WebSocket(WS_URL);

        ws.onopen = () => {
            console.log("[MCPBridge] Connected to MCP server");
        };

        ws.onmessage = async (event) => {
            try {
                const msg = JSON.parse(event.data);
                const { id, action, params } = msg;
                try {
                    const result = await handleAction(action, params || {});
                    ws?.send(JSON.stringify({ id, result }));
                } catch (e: any) {
                    ws?.send(JSON.stringify({ id, error: e.message || String(e) }));
                }
            } catch (e) {
                console.error("[MCPBridge] Bad message:", e);
            }
        };

        ws.onclose = () => {
            console.log("[MCPBridge] Disconnected from MCP server");
            ws = null;
            scheduleReconnect();
        };

        ws.onerror = () => {
            // onclose will fire after this
            ws?.close();
        };
    } catch (e) {
        console.error("[MCPBridge] Connection error:", e);
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (!enabled) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_INTERVAL);
}

function disconnect() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ws) {
        ws.onclose = null; // prevent reconnect
        ws.close();
        ws = null;
    }
}

// ── Channel Type Mapping ─────────────────────────────────────────────────────

const CHANNEL_TYPE_NAMES: Record<number, string> = {
    0: "text", 1: "dm", 2: "voice", 3: "group_dm", 4: "category",
    5: "announcement", 10: "announcement_thread", 11: "public_thread",
    12: "private_thread", 13: "stage", 14: "directory", 15: "forum", 16: "media"
};

const CHANNEL_TYPE_IDS: Record<string, number> = {
    text: 0, voice: 2, category: 4, announcement: 5, forum: 15, stage: 13
};

// ── Action Handlers ──────────────────────────────────────────────────────────

async function handleAction(action: string, params: any): Promise<any> {
    switch (action) {

        // ── Guilds ───────────────────────────────────────────────────────
        case "list_guilds": {
            const guilds = Object.values(GuildStore.getGuilds()) as any[];
            return guilds.map(g => ({
                id: g.id,
                name: g.name,
                icon: g.icon,
                owner_id: g.ownerId,
                member_count: g.memberCount,
                description: g.description
            }));
        }

        case "get_guild_info": {
            const g = GuildStore.getGuild(params.guild_id);
            if (!g) throw new Error("Guild not found");
            return {
                id: g.id, name: g.name, icon: g.icon,
                owner_id: g.ownerId, member_count: g.memberCount,
                description: g.description, vanity_url: g.vanityURLCode,
                premium_tier: g.premiumTier, premium_sub_count: g.premiumSubscriberCount
            };
        }

        // ── Channels ─────────────────────────────────────────────────────
        case "list_channels": {
            // Use REST API for reliable channel listing
            const res = await RestAPI.get({ url: `/guilds/${params.guild_id}/channels` });
            let channels = res.body as any[];
            if (params.type) {
                const typeId = CHANNEL_TYPE_IDS[params.type];
                if (typeId !== undefined) {
                    channels = channels.filter(c => c.type === typeId);
                }
            }
            return channels.map(c => ({
                id: c.id, name: c.name,
                type: CHANNEL_TYPE_NAMES[c.type] || c.type,
                position: c.position, parent_id: c.parent_id,
                topic: c.topic, nsfw: c.nsfw
            })).sort((a, b) => a.position - b.position);
        }

        case "get_channel_info": {
            const c = ChannelStore.getChannel(params.channel_id);
            if (!c) throw new Error("Channel not found");
            return {
                id: c.id, name: c.name,
                type: CHANNEL_TYPE_NAMES[c.type] || c.type,
                guild_id: c.guild_id, position: c.position,
                parent_id: c.parent_id, topic: c.topic,
                nsfw: c.nsfw, bitrate: c.bitrate,
                user_limit: c.userLimit, rate_limit: c.rateLimitPerUser
            };
        }

        // ── Messages ─────────────────────────────────────────────────────
        case "send_message": {
            const body: any = { content: params.content };
            if (params.tts) body.tts = true;
            if (params.reply_to) {
                body.message_reference = { message_id: params.reply_to };
            }
            const res = await RestAPI.post({
                url: `/channels/${params.channel_id}/messages`,
                body
            });
            return { success: true, channel_id: params.channel_id, message_id: (res.body as any).id };
        }

        case "edit_message": {
            await MessageActions.editMessage(params.channel_id, params.message_id, { content: params.content });
            return { success: true };
        }

        case "delete_message": {
            await MessageActions.deleteMessage(params.channel_id, params.message_id);
            return { success: true };
        }

        case "read_messages": {
            const limit = Math.min(params.limit || 50, 100);
            // Use REST API to fetch messages
            const res = await RestAPI.get({
                url: `/channels/${params.channel_id}/messages`,
                query: { limit }
            });
            return (res.body as any[]).map(m => ({
                id: m.id,
                author: { id: m.author.id, username: m.author.username, display_name: m.author.global_name },
                content: m.content,
                timestamp: m.timestamp,
                edited_timestamp: m.edited_timestamp,
                attachments: m.attachments?.map((a: any) => ({ filename: a.filename, url: a.url, size: a.size })),
                embeds: m.embeds?.length || 0,
                reactions: m.reactions?.map((r: any) => ({ emoji: r.emoji.name, count: r.count })),
                reply_to: m.referenced_message?.id,
                pinned: m.pinned
            }));
        }

        case "search_messages": {
            const query: Record<string, any> = { content: params.query };
            if (params.author_id) query.author_id = params.author_id;
            if (params.channel_id) query.channel_id = params.channel_id;
            query.include_nsfw = true;

            const guildId = params.guild_id || (params.channel_id ? ChannelStore.getChannel(params.channel_id)?.guild_id : null);
            if (!guildId) throw new Error("Need guild_id or channel_id in a guild");

            const res = await RestAPI.get({
                url: `/guilds/${guildId}/messages/search`,
                query
            });
            const messages = (res.body as any).messages || [];
            return {
                total: (res.body as any).total_results,
                messages: messages.flat().map((m: any) => ({
                    id: m.id,
                    channel_id: m.channel_id,
                    author: { id: m.author.id, username: m.author.username },
                    content: m.content,
                    timestamp: m.timestamp
                })).slice(0, params.limit || 25)
            };
        }

        // ── Reactions ────────────────────────────────────────────────────
        case "add_reaction": {
            const channel = ChannelStore.getChannel(params.channel_id);
            // Parse emoji — could be unicode or custom format name:id
            let emoji: any;
            if (params.emoji.includes(":")) {
                const [name, id] = params.emoji.split(":");
                emoji = { id, name, animated: false };
            } else {
                emoji = { id: null, name: params.emoji, animated: false };
            }
            await ReactionActions.addReaction(params.channel_id, params.message_id, emoji);
            return { success: true };
        }

        case "remove_reaction": {
            let emoji: any;
            if (params.emoji.includes(":")) {
                const [name, id] = params.emoji.split(":");
                emoji = { id, name, animated: false };
            } else {
                emoji = { id: null, name: params.emoji, animated: false };
            }
            await ReactionActions.removeReaction(params.channel_id, params.message_id, emoji);
            return { success: true };
        }

        // ── Users ────────────────────────────────────────────────────────
        case "get_current_user": {
            const u = UserStore.getCurrentUser();
            if (!u) throw new Error("Not logged in");
            return {
                id: u.id, username: u.username,
                display_name: u.globalName, discriminator: u.discriminator,
                avatar: u.avatar, email: u.email,
                premium_type: u.premiumType, status: PresenceStore?.getStatus(u.id)
            };
        }

        case "get_user_info": {
            const u = UserStore.getUser(params.user_id);
            if (!u) {
                // Try fetching from API
                const res = await RestAPI.get({ url: `/users/${params.user_id}` });
                const d = res.body as any;
                return {
                    id: d.id, username: d.username,
                    display_name: d.global_name, discriminator: d.discriminator,
                    avatar: d.avatar, bot: d.bot
                };
            }
            return {
                id: u.id, username: u.username,
                display_name: u.globalName, discriminator: u.discriminator,
                avatar: u.avatar, bot: u.bot,
                status: PresenceStore?.getStatus(u.id)
            };
        }

        case "list_guild_members": {
            const limit = Math.min(params.limit || 100, 1000);
            const res = await RestAPI.get({
                url: `/guilds/${params.guild_id}/members`,
                query: { limit }
            });
            return (res.body as any[]).map((m: any) => ({
                user_id: m.user.id,
                username: m.user.username,
                display_name: m.user.global_name,
                nickname: m.nick,
                roles: m.roles,
                joined_at: m.joined_at,
                avatar: m.avatar
            }));
        }

        // ── DMs ──────────────────────────────────────────────────────────
        case "list_dms": {
            const dmIds = DMChannelStore.getPrivateChannelIds();
            return dmIds.map((id: string) => {
                const c = ChannelStore.getChannel(id);
                if (!c) return { id };
                const recipients = c.recipients?.map((uid: string) => {
                    const u = UserStore.getUser(uid);
                    return { id: uid, username: u?.username, display_name: u?.globalName };
                }) || [];
                return {
                    id: c.id,
                    type: CHANNEL_TYPE_NAMES[c.type] || c.type,
                    name: c.name,
                    recipients
                };
            });
        }

        case "send_dm": {
            // Open or get DM channel, then send
            const res = await RestAPI.post({
                url: "/users/@me/channels",
                body: { recipient_id: params.user_id }
            });
            const channelId = (res.body as any).id;
            await MessageActions.sendMessage(channelId, { content: params.content });
            return { success: true, channel_id: channelId };
        }

        // ── Status ───────────────────────────────────────────────────────
        case "set_status": {
            if (params.status) {
                // Set online/idle/dnd/invisible
                FluxDispatcher.dispatch({
                    type: "SELF_PRESENCE_STORE_UPDATE",
                    status: params.status
                });
            }
            if (params.text !== undefined || params.emoji) {
                const customStatus: any = {};
                if (params.text) customStatus.text = params.text;
                if (params.emoji) customStatus.emoji_name = params.emoji;
                customStatus.expires_at = null;

                await RestAPI.patch({
                    url: "/users/@me/settings",
                    body: { custom_status: params.text || params.emoji ? customStatus : null }
                });
            }
            return { success: true };
        }

        // ── Voice ────────────────────────────────────────────────────────
        case "join_voice": {
            await VoiceActions.selectVoiceChannel(params.channel_id, {
                guildId: params.guild_id,
                selfMute: params.self_mute || false,
                selfDeaf: params.self_deaf || false
            });
            return { success: true, channel_id: params.channel_id };
        }

        case "leave_voice": {
            await VoiceActions.selectVoiceChannel(null);
            return { success: true };
        }

        // ── Roles ────────────────────────────────────────────────────────
        case "list_roles": {
            const guild = GuildStore.getGuild(params.guild_id);
            if (!guild) throw new Error("Guild not found");
            const roles = Object.values(guild.roles) as any[];
            return roles
                .sort((a, b) => b.position - a.position)
                .map(r => ({
                    id: r.id, name: r.name, color: r.color,
                    position: r.position, permissions: r.permissions?.toString(),
                    mentionable: r.mentionable, hoist: r.hoist,
                    managed: r.managed
                }));
        }

        // ── Channel Management ───────────────────────────────────────────
        case "create_channel": {
            const body: any = {
                name: params.name,
                type: CHANNEL_TYPE_IDS[params.type || "text"] ?? 0
            };
            if (params.parent_id) body.parent_id = params.parent_id;
            if (params.topic) body.topic = params.topic;

            const res = await RestAPI.post({
                url: `/guilds/${params.guild_id}/channels`,
                body
            });
            return { success: true, channel: { id: (res.body as any).id, name: (res.body as any).name } };
        }

        case "delete_channel": {
            await RestAPI.del({ url: `/channels/${params.channel_id}` });
            return { success: true };
        }

        // ── Threads ──────────────────────────────────────────────────────
        case "create_thread": {
            const body: any = {
                name: params.name,
                auto_archive_duration: params.auto_archive_duration || 1440,
                type: 11 // public thread
            };

            let url: string;
            if (params.message_id) {
                url = `/channels/${params.channel_id}/messages/${params.message_id}/threads`;
            } else {
                url = `/channels/${params.channel_id}/threads`;
            }

            const res = await RestAPI.post({ url, body });
            return { success: true, thread: { id: (res.body as any).id, name: (res.body as any).name } };
        }

        // ── Typing ───────────────────────────────────────────────────────
        case "start_typing": {
            TypingActions.startTyping(params.channel_id);
            return { success: true };
        }

        // ── Pins ─────────────────────────────────────────────────────────
        case "pin_message": {
            await RestAPI.put({ url: `/channels/${params.channel_id}/pins/${params.message_id}` });
            return { success: true };
        }

        case "unpin_message": {
            await RestAPI.del({ url: `/channels/${params.channel_id}/pins/${params.message_id}` });
            return { success: true };
        }

        // ── Nickname ─────────────────────────────────────────────────────
        case "set_nickname": {
            const me = UserStore.getCurrentUser();
            await RestAPI.patch({
                url: `/guilds/${params.guild_id}/members/${me.id}`,
                body: { nick: params.nickname || null }
            });
            return { success: true };
        }

        default:
            throw new Error(`Unknown action: ${action}`);
    }
}

// ── Plugin Definition ────────────────────────────────────────────────────────

export default definePlugin({
    name: "MCPBridge",
    description: "Bridge between Discord and MCP server — lets AI agents control Discord",
    authors: [{ name: "Sushi", id: 0n }],
    required: false,

    start() {
        enabled = true;
        connect();
        console.log("[MCPBridge] Plugin started — connecting to MCP server...");
    },

    stop() {
        enabled = false;
        disconnect();
        console.log("[MCPBridge] Plugin stopped");
    }
});
