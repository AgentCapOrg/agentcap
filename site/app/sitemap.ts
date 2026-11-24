import type { MetadataRoute } from "next";

const base = "https://agentcap.xyz";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/docs", "/claude", "/grok", "/api","/token", "/governance", "/terms", "/privacy"].map((path) => ({
    url: `${base}${path}`,
    changeFrequency: "monthly",
    priority: path === "" ? 1 : 0.7,
  }));
}
