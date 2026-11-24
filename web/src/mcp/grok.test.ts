import assert from "node:assert/strict";
import { test } from "node:test";
import { grokBotSetupPrompt, grokMcpConfig } from "./grok";
import { PLUGIN_SERVER_URL } from "./install-links";
import { llmsTxt } from "./assistant-setup";
import { DIRECTORY_INSTRUCTIONS, SERVER_INSTRUCTIONS, SETUP_WORKFLOW } from "./instructions";

test("Grok's portable config is credential-free and preserves the configured endpoint", () => {
  for (const server of [PLUGIN_SERVER_URL, "https://staging.example/mcp?workspace=a&b=\"漢\""]) {
    assert.deepEqual(JSON.parse(grokMcpConfig(server)), { mcpServers: { agentcap: { url: server } } });
  }
});

test("a self-hosted Bot is sent only to its own setup server and instructions", () => {
  const input = { server: "https://mcp.staging.test/mcp", app: "https://staging.test" };
  const prompt = grokBotSetupPrompt(input);
  assert.ok(prompt.includes(input.server));
  assert.ok(prompt.includes(`${input.app}/llms.txt`));
  assert.ok(!prompt.includes("agentcap.xyz"));
  const text = llmsTxt(input);
  assert.ok(text.includes(prompt));
  assert.ok(text.includes(grokMcpConfig(input.server)));
  assert.ok(text.includes(`grok mcp add --transport http agentcap ${input.server}`));
});

test("the Bot setup workflow preserves owner handoffs and requires worker evidence", () => {
  const prompt = grokBotSetupPrompt({ server: PLUGIN_SERVER_URL, app: "https://app.agentcap.xyz" });
  assert.ok(prompt.includes("https://agentcap.xyz/llms.txt"));
  assert.ok(prompt.includes("get_agentcapavatar_setup"));
  assert.ok(prompt.includes("create_agentcapavatar only if that tool is granted"));
  assert.ok(prompt.includes("browser on my own device"));
  assert.ok(prompt.includes("Do not sign in to AgentCap, approve proposals, create wallets or sign permissions through the Bot's shared cloud computer"));
  assert.ok(prompt.includes("phase=paper with a fresh worker report"));
  assert.ok(prompt.includes("Do not create a monitoring routine unless I ask"));
  assert.ok(prompt.includes("Do not create drafts, propose or approve trades, change settings or retry orders in a routine"));
});

test("native hosts and the Bot prompt receive the same setup workflow without changing the read-only directory", () => {
  const prompt = grokBotSetupPrompt({ server: PLUGIN_SERVER_URL, app: "https://app.agentcap.xyz" });
  assert.ok(prompt.includes(SETUP_WORKFLOW));
  assert.ok(SERVER_INSTRUCTIONS.includes(SETUP_WORKFLOW));
  assert.ok(!DIRECTORY_INSTRUCTIONS.includes(SETUP_WORKFLOW));
  assert.ok(!DIRECTORY_INSTRUCTIONS.includes("create_agentcapavatar"));
});
