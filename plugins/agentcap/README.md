# AgentCap for Claude Code

Create or manage your hosted AgentCap trading agent from Claude Code: what needs you, its
status, why it has or hasn't traded, your portfolio, a weekly review and token research.

For Claude on the web, Desktop, Cowork or mobile, use the remote connector at
[Connect AgentCap](https://app.agentcap.xyz/connect/mcp); no terminal is needed.
ChatGPT and dots need a supported ChatGPT plugin for this MCP server, installed,
connected and enabled. Availability depends on the host and workspace.

MCP Apps hosts also get an interactive home for name, strategy, basket, risk, readiness, portfolio, activity, editable settings, pending approvals and Telegram alerts. A focused secure handoff carries the chosen setup into wallet authorization. Other hosts use the same tools as text; owner approval and wallet signing always remain in AgentCap.

## Install

Inside Claude Code, run these one at a time:

```text
/plugin marketplace add https://github.com/millw14/agentcap.git
/plugin install agentcap@agentcap
```

Or from a terminal:

```bash
claude plugin marketplace add https://github.com/millw14/agentcap.git
claude plugin install agentcap@agentcap
```

Then sign in once: type `/mcp`, choose `plugin:agentcap:agentcap`, choose
**Authenticate**, and click **Allow** on the AgentCap page that opens (or run
`/agentcap:connect` and follow along).

Already added AgentCap to Claude on claude.ai? If Claude Code is signed in with
the same Claude account, the connector is in Claude Code already (`/mcp` lists
it as `claude.ai AgentCap`). The plugin still adds the commands below; its own
server takes over from the connector, so you sign in once more.

## Commands

| Command | What it does |
|---|---|
| `/agentcap:brief` | What needs you across your agents: a morning brief, or a quiet check-in that speaks only when something is new |
| `/agentcap:status` | Is the agent running, paper or live, anything blocking it, when its permission expires |
| `/agentcap:why` | Why it has or hasn't traded, from its recorded state and decisions |
| `/agentcap:portfolio` | Cash, positions, profit and loss, paper and live kept apart |
| `/agentcap:week` | A week-in-review, and anything you need to do |
| `/agentcap:token <address or symbol>` | Research a token and whether your agent could trade it |
| `/agentcap:connect` | Sign in, or fix a connection that isn't working |

You can also ask "set up my AgentCapAvatar" or "how's my AgentCapAvatar doing?". Setup
starts with `get_agentcapavatar_setup`. For a new agent, `create_agentcapavatar` prepares
your name, strategy and risk choices for review. You approve and sign the
wallet permission on AgentCap; a draft alone does not activate trading.
The hosted worker runs after activation even when the conversation closes.
Changes to an existing agent use owner-approved configuration proposals.

## What it can and cannot do

The connection sees only the agent and the permissions you allow when you sign
in, and you can disconnect it any time on
[Connected apps](https://app.agentcap.xyz/connect/apps). It can suggest trades
or setting changes only if you allowed that, and nothing happens until you
approve each one in AgentCap. It can never move your funds, see your keys, turn
on live trading or loosen your limits.

Server: `https://mcp.agentcap.xyz/mcp`. More ways to connect:
<https://app.agentcap.xyz/connect/mcp>.

## Maintaining this plugin

Claude Code caches an installed plugin by the `version` in
`.claude-plugin/plugin.json` and delivers a change only when that version
moves. Any change to `.mcp.json` or a skill therefore needs a version bump, or
people who installed it earlier keep the old copy. `web/src/mcp/claude-plugin.test.ts`
fingerprints those files and fails until the version and the fingerprint are
updated together. Check a change with
`claude plugin validate --strict plugins/agentcap` and `claude plugin validate --strict .`.
