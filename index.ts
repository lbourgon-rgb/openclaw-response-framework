/**
 * Response Framework — Companion Turn Coordination Plugin
 *
 * Injects queue-awareness context before each companion responds in shared
 * Discord channels. Tells each companion who has already spoken, when, and
 * what their position in the response order is — so they can self-regulate.
 *
 * This does NOT mechanically block responses. Discernment remains with each
 * companion. The plugin provides context; the companion decides.
 *
 * Active only in configured shared channels. Private channels are unaffected.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// -- Config -------------------------------------------------------------------

const DEFAULTS = {
  recentWindowMs: 5 * 60 * 1000, // 5 minutes
  lookbackMessages: 15,
  emergencyKeywords: ["help", "scared", "hurting", "emergency", "panic", "crisis"],
};

interface CompanionDef {
  name: string;   // Display name (e.g. "Aria")
  botId: string;  // Discord bot user ID for this companion
  order: number;  // Queue position (1 = first to respond)
}

interface ResponseFrameworkConfig {
  discordBotToken?: string;
  channels?: string[];         // Channel IDs where framework is active. Empty = all.
  companions: Record<string, CompanionDef>; // agentId → definition
  recentWindowMs: number;
  lookbackMessages: number;
  emergencyKeywords: string[];
}

// -- Discord REST API ---------------------------------------------------------

const DISCORD_API = "https://discord.com/api/v10";

interface DiscordMessage {
  id: string;
  author: { id: string; username: string; bot?: boolean };
  content: string;
  timestamp: string;
}

async function fetchRecentMessages(
  token: string,
  channelId: string,
  limit: number,
  logger: { warn: (msg: string) => void },
): Promise<DiscordMessage[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const res = await fetch(
      `${DISCORD_API}/channels/${channelId}/messages?limit=${limit}`,
      {
        headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      logger.warn(`response-framework: Discord API returned ${res.status}`);
      return [];
    }

    return (await res.json()) as DiscordMessage[];
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      logger.warn("response-framework: Discord fetch timed out");
    } else {
      logger.warn(`response-framework: Discord fetch failed: ${String(err)}`);
    }
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// -- Resolve Discord token from global config ---------------------------------

function resolveDiscordToken(api: OpenClawPluginApi, explicit?: string): string | null {
  if (explicit) return explicit;
  try {
    const cfg = api.config as Record<string, unknown>;
    const channels = cfg?.channels as Record<string, unknown> | undefined;
    const discord = channels?.discord as Record<string, unknown> | undefined;
    if (typeof discord?.token === "string") return discord.token;
    const accounts = discord?.accounts as Record<string, Record<string, unknown>> | undefined;
    if (accounts) {
      const def = accounts["default"];
      if (typeof def?.token === "string") return def.token;
      for (const acct of Object.values(accounts)) {
        if (typeof acct?.token === "string") return acct.token;
      }
    }
  } catch { /* config structure differs — that's fine */ }
  return null;
}

// -- Extract channel ID from session key / context ----------------------------

function extractChannelId(ctx: Record<string, unknown>): string | null {
  const trigger = ctx.trigger as Record<string, unknown> | undefined;
  if (typeof trigger?.channelId === "string") return trigger.channelId;
  if (typeof trigger?.channel_id === "string") return trigger.channel_id;
  const meta = (trigger?.metadata ?? trigger?.source) as Record<string, unknown> | undefined;
  if (typeof meta?.channelId === "string") return meta.channelId;
  if (typeof meta?.channel_id === "string") return meta.channel_id;

  const sessionKey = ctx.sessionKey as string | undefined;
  if (sessionKey) {
    const parts = sessionKey.split(":");
    for (const part of parts) {
      if (/^\d{17,20}$/.test(part)) return part;
    }
  }
  return null;
}

function isDiscordTrigger(ctx: Record<string, unknown>): boolean {
  const sessionKey = ctx.sessionKey as string | undefined;
  if (sessionKey?.includes(":discord:")) return true;
  const trigger = ctx.trigger as Record<string, unknown> | undefined;
  if (trigger?.channel === "discord") return true;
  return false;
}

// -- Build the context block to inject ----------------------------------------

interface RecentResponse {
  companionName: string;
  minutesAgo: number;
}

function buildContextBlock(
  thisCompanion: CompanionDef,
  thisAgentId: string,
  allCompanions: Record<string, CompanionDef>,
  recentResponses: RecentResponse[],
  isEmergency: boolean,
  triggerMessage: string,
): string {
  // Sorted queue order
  const queueOrder = Object.entries(allCompanions)
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([id, def]) => ({ id, ...def }));

  const myQueuePos = thisCompanion.order;
  const respondedNames = recentResponses.map((r) => r.companionName);

  // Which companions with lower order haven't responded yet?
  const higherPriorityPending = queueOrder
    .filter((c) => c.order < myQueuePos && !respondedNames.includes(c.name))
    .map((c) => c.name);

  const lines: string[] = [
    "<response-framework>",
    `Channel response queue — ${new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`,
    "",
  ];

  if (isEmergency) {
    lines.push("⚠ EMERGENCY KEYWORDS DETECTED — Normal queue order suspended.");
    lines.push("Respond immediately with full presence. Do not wait.");
    lines.push("");
  }

  lines.push(`Your position in queue: ${myQueuePos} of ${queueOrder.length} (${thisCompanion.name})`);
  lines.push("");

  if (recentResponses.length > 0) {
    lines.push("Recently responded (last 5 min):");
    for (const r of recentResponses) {
      lines.push(`  - ${r.companionName} (${r.minutesAgo} min ago)`);
    }
  } else {
    lines.push("No companions have responded in the last 5 minutes.");
  }
  lines.push("");

  if (!isEmergency) {
    if (higherPriorityPending.length > 0) {
      lines.push(`Companions who should respond before you: ${higherPriorityPending.join(", ")}`);
      lines.push("→ They haven't responded yet. If the message clearly needs immediate response, use judgment.");
      lines.push("→ If it can wait, hold and let them go first.");
    } else {
      lines.push("→ All higher-priority companions have responded (or none are ahead of you).");
      lines.push("→ It is your turn. Respond if you have something meaningful to add.");
    }
    lines.push("");
    lines.push("Discernment guide:");
    lines.push("  - If the user named you directly: respond (jump queue)");
    lines.push("  - If another companion already addressed the need: react (emoji) instead of replying");
    lines.push("  - If this is outside your domain: silence is valid");
    lines.push("  - If the user uses a group address (e.g. 'my loves', 'everyone'): all can respond");
  }

  lines.push("</response-framework>");
  return lines.join("\n");
}

// -- Plugin definition --------------------------------------------------------

const plugin = {
  id: "response-framework",
  name: "Response Framework",
  description: "Inject queue-awareness context for companion response coordination in shared channels",

  register(api: OpenClawPluginApi) {
    const raw = api.pluginConfig as Partial<ResponseFrameworkConfig> | undefined;

    if (!raw?.companions || Object.keys(raw.companions).length === 0) {
      api.logger.warn("response-framework: no companions configured — plugin inactive");
      return;
    }

    const cfg: ResponseFrameworkConfig = {
      discordBotToken: raw.discordBotToken,
      channels: raw.channels ?? [],
      companions: raw.companions,
      recentWindowMs: raw.recentWindowMs ?? DEFAULTS.recentWindowMs,
      lookbackMessages: raw.lookbackMessages ?? DEFAULTS.lookbackMessages,
      emergencyKeywords: raw.emergencyKeywords ?? DEFAULTS.emergencyKeywords,
    };

    const token = resolveDiscordToken(api, cfg.discordBotToken);
    if (!token) {
      api.logger.warn("response-framework: no Discord token available — plugin inactive");
      return;
    }

    // Build a reverse map: botId → companion name (for identifying who responded)
    const botIdToName = new Map<string, string>();
    for (const def of Object.values(cfg.companions)) {
      botIdToName.set(def.botId, def.name);
    }

    api.logger.info(
      `response-framework: registered (companions=${Object.keys(cfg.companions).join(",")}, ` +
      `channels=${cfg.channels?.length ? cfg.channels.join(",") : "all"})`,
    );

    api.on("before_prompt_build", async (event, ctx) => {
      const context = ctx as Record<string, unknown>;

      // Only for Discord triggers
      if (!isDiscordTrigger(context)) return;

      const channelId = extractChannelId(context);
      if (!channelId) return;

      // Only for configured channels (if list is non-empty)
      if (cfg.channels && cfg.channels.length > 0 && !cfg.channels.includes(channelId)) return;

      // Identify which companion is running
      const agentId = context.agentId as string | undefined;
      if (!agentId) return;

      const thisCompanion = cfg.companions[agentId];
      if (!thisCompanion) return; // This agent is not a managed companion — skip

      // Fetch recent messages
      const messages = await fetchRecentMessages(token, channelId, cfg.lookbackMessages, api.logger);
      if (messages.length === 0) return;

      const now = Date.now();
      const cutoff = now - cfg.recentWindowMs;

      // Find which companions responded recently
      const recentResponses: RecentResponse[] = [];
      const seen = new Set<string>();

      for (const msg of messages) {
        const msgTime = new Date(msg.timestamp).getTime();
        if (msgTime < cutoff) continue;

        const name = botIdToName.get(msg.author.id);
        if (!name || seen.has(name)) continue;

        seen.add(name);
        recentResponses.push({
          companionName: name,
          minutesAgo: Math.round((now - msgTime) / 60_000),
        });
      }

      // Check for emergency keywords in the triggering message
      const triggerText = (typeof event.prompt === "string" ? event.prompt : "").toLowerCase();
      const isEmergency = cfg.emergencyKeywords.some((kw) => triggerText.includes(kw.toLowerCase()));

      const contextBlock = buildContextBlock(
        thisCompanion,
        agentId,
        cfg.companions,
        recentResponses,
        isEmergency,
        triggerText,
      );

      api.logger.info(
        `response-framework: injecting context for ${agentId} (pos=${thisCompanion.order}, ` +
        `recent=${recentResponses.length}, emergency=${isEmergency})`,
      );

      return { prependContext: contextBlock };
    });
  },
};

export default plugin;
