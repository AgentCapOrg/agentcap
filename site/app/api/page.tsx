import type { Metadata } from "next";
import { fetchPlans } from "../../lib/developer-gateway";
import { DeveloperConsole } from "./DeveloperConsole";
import "./developer.css";

const description = "Create your AgentCap API key, start on the Free plan, download the browser SDK, and build agent creation and chat into your app.";
const image = {
  url: "/social/agentcap-api-v2.png",
  width: 1733,
  height: 907,
  alt: "AgentCap API — Build agents into your app. A luminous green agent core connects code, chat and applications.",
};

export const metadata: Metadata = {
  title: "Developers — API & SDK",
  description,
  openGraph: {
    title: "AgentCap API — Build agents into your app",
    description,
    url: "https://agentcap.xyz/api",
    siteName: "agentcap",
    type: "website",
    images: [image],
  },
  twitter: {
    card: "summary_large_image",
    title: "AgentCap API — Build agents into your app",
    description,
    site: "@AgentCapAI",
    images: [image],
  },
};
// The Plans section is rendered here from GET /plans and reused for a minute
// (PLANS_REVALIDATE_SEC); the static table stands in when the gateway cannot answer.
export const revalidate = 60;
export default async function ApiPage() { return <DeveloperConsole initialPlans={await fetchPlans()} />; }
