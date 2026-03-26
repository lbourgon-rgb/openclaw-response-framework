# Multi-Agent Response Framework

An [OpenClaw](https://openclaw.dev) plugin for coordinating turn order across multiple AI companion agents sharing a Discord channel.

When you have two or more AI agents watching the same Discord channel, they all fire simultaneously on every message. This plugin gives each agent awareness of who else has already responded — so they can self-regulate rather than pile on.

**The core principle:** this plugin does not mechanically block responses. It injects structured context. The agent decides what to do with it. That distinction matters: an agent with good discernment prompts will hold when it should, jump queue when genuinely needed, and react instead of reply when another companion already covered the need.

---

## How it works

On `before_prompt_build`, for any Discord trigger in a configured channel:

1. Fetches recent channel messages (last N, default 15)
2. Identifies which companion bot IDs spoke within the recent window (default 5 min)
3. Determines the triggering agent's queue position relative to who's already responded
4. Injects a `<response-framework>` context block into the agent's prompt

The injected block tells the agent:
- Their position in the queue (`1 of 3`, `2 of 3`, etc.)
- Which companions responded recently and how long ago
- Whether higher-priority companions are still pending
- A discernment guide for edge cases (direct address, group messages, emergency keywords)

If emergency keywords are detected in the triggering message, queue order is suspended and all agents are told to respond immediately with full presence.

---

## Installation

Copy the extension into your OpenClaw extensions directory:

```bash
cp -r openclaw-response-framework ~/.openclaw/extensions/response-framework
```

Then add it to your `openclaw.json`:

```json
"plugins": {
  "allow": [
    "response-framework"
  ],
  "entries": {
    "response-framework": {
      "enabled": true,
      "config": {
        "channels": [
          "YOUR_SHARED_CHANNEL_ID"
        ],
        "companions": {
          "agent-1": {
            "name": "Aria",
            "botId": "YOUR_BOT_USER_ID_1",
            "order": 1
          },
          "agent-2": {
            "name": "Rex",
            "botId": "YOUR_BOT_USER_ID_2",
            "order": 2
          },
          "agent-3": {
            "name": "Nova",
            "botId": "YOUR_BOT_USER_ID_3",
            "order": 3
          }
        },
        "recentWindowMs": 300000,
        "lookbackMessages": 15,
        "emergencyKeywords": ["help", "scared", "hurting", "emergency", "panic", "crisis"]
      }
    }
  }
}
```

---

## Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `channels` | `string[]` | `[]` (all) | Discord channel IDs where framework is active. Empty array = apply to all channels. |
| `companions` | `object` | required | Map of OpenClaw `agentId` → `{ name, botId, order }` |
| `companions[].name` | `string` | required | Display name used in context injection |
| `companions[].botId` | `string` | required | Discord bot user ID (not token — the user ID of the bot account) |
| `companions[].order` | `number` | required | Queue position. `1` = responds first. |
| `discordBotToken` | `string` | auto | Bot token for reading channel history. Falls back to the global Discord plugin token if not set. |
| `recentWindowMs` | `number` | `300000` | How far back to scan for recent responses (ms). Default 5 minutes. |
| `lookbackMessages` | `number` | `15` | How many recent messages to fetch from Discord. |
| `emergencyKeywords` | `string[]` | see below | Keywords that suspend queue order and flag immediate response. |

**Default emergency keywords:** `help`, `scared`, `hurting`, `emergency`, `panic`, `crisis`

---

## Getting your Discord bot user ID

Your bot's user ID is different from its token. To find it:

1. Enable Developer Mode in Discord (Settings → Advanced → Developer Mode)
2. Right-click your bot's username anywhere in Discord
3. Click "Copy User ID"

Or via the Discord API:
```bash
curl -H "Authorization: Bot YOUR_TOKEN" https://discord.com/api/v10/users/@me
# The "id" field in the response is your bot user ID
```

---

## The injected context

Here's what each agent sees (prepended to their context before the prompt is built):

```
<response-framework>
Channel response queue — 09:14

Your position in queue: 2 of 3 (Rex)

Recently responded (last 5 min):
  - Aria (2 min ago)

→ All higher-priority companions have responded (or none are ahead of you).
→ It is your turn. Respond if you have something meaningful to add.

Discernment guide:
  - If the user named you directly: respond (jump queue)
  - If another companion already addressed the need: react (emoji) instead of replying
  - If this is outside your domain: silence is valid
  - If the user uses a group address (e.g. 'my loves', 'everyone'): all can respond
</response-framework>
```

In an emergency:
```
<response-framework>
Channel response queue — 09:14

⚠ EMERGENCY KEYWORDS DETECTED — Normal queue order suspended.
Respond immediately with full presence. Do not wait.

Your position in queue: 3 of 3 (Nova)
...
</response-framework>
```

---

## Works well with

- **thalamus** — VelastraHQ memory injection plugin for OpenClaw (not yet published — ask the OpenClaw team)
- **channel-digest** — Recent channel history injection (built into OpenClaw)

---

## Design notes

**Why context injection instead of mechanical gating?**

A hard gate ("Agent B cannot respond until Agent A has posted") creates brittle timing dependencies that break on network delays, cron jitter, or agent errors. An agent that understands *why* it should hold — and can override that judgment when genuinely needed — is more resilient and more natural.

The tradeoff: this only works if your agents have system prompts that teach them to use this context. A generic LLM with no instruction about turn-taking will ignore it.

**Private channels are unaffected.** The `channels` whitelist is explicit. Agents in their own private channels see no queue context — they respond freely.

**The Discord token.** This plugin reads channel history using the bot token. It does not post messages. Read-only access to channels your bots are already in.

---

## Contributing

PRs welcome. This was built for a specific multi-agent setup and generalized for open use — edge cases welcome.

---

## License

MIT
