import type { Metadata } from "next";
import { HeroSignal } from "../../components/HeroSignal";
import { Icon } from "../../components/Icon";
import { Logo } from "../../components/Logo";
import { GrokQuickStart } from "./GrokQuickStart";
import "./grok.css";

const title = "Your AgentCapAvatar. Now in Grok.";
const description = "Connect AgentCap to Grok. Set up your trading agent, understand its decisions and check its status from chat. Your wallet approvals stay with you. No model API key needed.";
const SERVER = "https://mcp.agentcap.xyz/mcp";
const CONNECT_HUB = "https://app.agentcap.xyz/connect/mcp";
const CONNECTED_APPS = "https://app.agentcap.xyz/connect/apps";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/grok" },
  openGraph: { title, description, url: "https://agentcap.xyz/grok", siteName: "agentcap", type: "website" },
  twitter: { card: "summary", title, description, site: "@AgentCapAI", creator: "@AgentCapAI" },
};

export default function GrokSetup() {
  return (
    <div className="home-page grok-page">
      <section className="grok-hero" aria-labelledby="grok-title">
        <div className="wrap grok-hero-layout">
          <div className="grok-hero-copy">
            <p className="hero-eyebrow">AgentCap × Grok</p>
            <h1 id="grok-title">Your AgentCapAvatar.<br /><span>Now in Grok.</span></h1>
            <p className="grok-hero-lead">Give your trading agent a place in the conversation. Set it up, understand its decisions, and check what it is doing. You keep the keys and approve the limits.</p>
            <div className="grok-hero-actions">
              <a className="btn btn-primary btn-lg" href="https://grok.com/connectors" target="_blank" rel="noopener noreferrer">
                Open Grok connectors <Icon name="arrow" size={18} />
                <span className="grok-sr-only"> (opens in a new tab)</span>
              </a>
              <a className="grok-text-link" href="#setup">See the three steps <span aria-hidden>↓</span></a>
            </div>
            <p className="grok-hero-note">Add a custom connector once. No model API key needed.</p>
          </div>
          <div className="grok-hero-stage">
            <HeroSignal />
            <figure className="grok-example">
              <figcaption>Example conversation</figcaption>
              <p className="grok-example-prompt">Set up a practice AgentCapAvatar for me.</p>
              <div className="grok-example-reply">
                <span className="grok-example-mark"><Logo size={25} /><strong>AgentCap</strong></span>
                <p>A strategy you choose.<br />Limits you approve.<br />A status you can check.</p>
                <div className="grok-example-handoff"><Icon name="wallet" size={18} /><span>Review and sign in AgentCap</span><Icon name="arrow" size={16} /></div>
              </div>
              <p className="grok-example-foot">Your conversation starts the setup.<br />Your approval makes it yours.</p>
            </figure>
          </div>
        </div>
      </section>

      <div className="wrap">
        <GrokQuickStart server={SERVER} />
        <section className="grok-use-section" aria-labelledby="grok-use-title">
          <div className="grok-section-intro">
            <div className="tag"><span className="n">02</span> — once connected</div>
            <h2 id="grok-use-title">Less dashboard.<br />More conversation.</h2>
            <p>Ask about the AgentCap you share with Grok. Get the next step, the reason, or the receipt.</p>
          </div>
          <div className="grok-use-list">
            <div><Icon name="chat" size={22} /><h3>Get ready</h3><p>“What remains before my AgentCapAvatar is running?”</p></div>
            <div><Icon name="eye" size={22} /><h3>Understand a decision</h3><p>“Why hasn’t my agent traded?”</p></div>
            <div><Icon name="ledger" size={22} /><h3>Check the receipts</h3><p>“Show my recent trades. Keep practice and live separate.”</p></div>
          </div>
        </section>
        <section className="grok-control" aria-labelledby="grok-control-title">
          <div className="tag"><span className="n">03</span> — your rules</div>
          <div className="grok-control-layout">
            <h2 id="grok-control-title">The conversation changes.<br /><span>Your control doesn’t.</span></h2>
            <div>
              <p>You choose the AgentCapAvatar and permissions to share. Grok can read what you allow and prepare proposals. You review setup and wallet permissions in AgentCap.</p>
              <p>The connector cannot sign wallet transactions or loosen your signed limits. Disconnect any time in <a href={CONNECTED_APPS}>Connected apps</a>.</p>
            </div>
          </div>
        </section>
        <section className="grok-help" aria-labelledby="grok-help-title">
          <div className="grok-section-intro">
            <div className="tag"><span className="n">04</span> — a little help</div>
            <h2 id="grok-help-title">One connection.<br />A few good answers.</h2>
            <p>New to AgentCap? You can create your account during connection.</p>
          </div>
          <div className="grok-faq">
            <details>
              <summary>Why can’t Grok find AgentCap by name?<span aria-hidden>+</span></summary>
              <p>Add AgentCap manually as a custom connector first. Asking chat to find it searches a catalog and does not install this connection. Use the name and server address in <a href="#setup">step one</a>.</p>
            </details>
            <details>
              <summary>Do I need an API key or a paid Grok plan?<span aria-hidden>+</span></summary>
              <p>No model API key or extra model service is needed. xAI says connectors are available to all Grok users. Business and Enterprise connectors must be provisioned by your administrator. See the <a href="https://docs.x.ai/grok/connectors" target="_blank" rel="noopener noreferrer">official Grok connector guide</a>.</p>
            </details>
            <details>
              <summary>Connected, but no AgentCapAvatar or setup tool?<span aria-hidden>+</span></summary>
              <p>Finish authentication with the AgentCap account that owns your agent and select it on the consent page. To prepare a new agent from chat, reconnect and allow “Prepare agent setups and suggest setting changes.” You can also finish setup directly in AgentCap.</p>
            </details>
            <details>
              <summary>Does “approved” mean it is running?<span aria-hidden>+</span></summary>
              <p>Not yet. Open the latest AgentCap setup link and complete any remaining owner steps. Then ask Grok to check status again. Practice and live are separate, and a running agent may wait when its strategy or limits do not permit a trade.</p>
            </details>
            <details>
              <summary>What has been tested?<span aria-hidden>+</span></summary>
              <p>Grok web has been tested through fresh-account signup, connection, the interactive setup card, owner wallet signing and a fresh practice-worker report. If a host cannot display the card, use its text response and open the AgentCap review link yourself. Full Grok Bot setup remains unverified.</p>
            </details>
            <p className="grok-support">Still stuck? <a href="mailto:support@agentcap.xyz">Ask us for help <Icon name="arrow" size={14} /></a></p>
          </div>
        </section>
        <section className="grok-bot" id="grok-bot" aria-labelledby="grok-bot-title">
          <div className="grok-bot-heading"><Icon name="terminal" size={25} /><h2 id="grok-bot-title">Working with Grok Bot?</h2></div>
          <div className="grok-bot-copy">
            <p>Set up the Bot separately. Get the AgentCap setup prompt and configuration, then check which custom MCP options your Bot supports. A AgentCap catalog listing and personal Bot installation have not been verified.</p>
            <p>Open sign-in and wallet approval links on your own device. Keep your wallet and sign-in codes off the Bot’s shared computer.</p>
            <div className="grok-bot-links"><a className="grok-text-link" href={`${CONNECT_HUB}#grok-bot`}>Get the Bot setup prompt <Icon name="arrow" size={16} /></a><a href="https://docs.x.ai/grok-bot/computer-and-apps" target="_blank" rel="noopener noreferrer">Grok Bot documentation</a></div>
          </div>
        </section>
      </div>
    </div>
  );
}
