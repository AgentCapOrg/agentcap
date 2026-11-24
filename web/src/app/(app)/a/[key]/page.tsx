export const dynamic = "force-dynamic";
import { SLUG_RE } from "@agentcap/identity-store";
import { readAgent } from "@/lib/read-agent";
export async function generateMetadata({params}:{params:Promise<{key:string}>}) {
  const {key}=await params;
  if (!SLUG_RE.test(key)) return {title:"Agent — agentcap"};
  const agent=await readAgent(key);
  return {title:`${agent?.name ?? "Agent"} — agentcap`};
}
export default function AgentProfileRoute() {return null;}
