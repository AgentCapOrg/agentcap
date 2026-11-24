package dev.agentcap.app.net

/** Find public agents without waiting for every account's historical performance. */
suspend fun AgentCapApi.agentDirectory(): ApiResult<Leaderboard> =
  getJson("/api/leaderboard?view=directory")

/** Publication-gated activity; outcomes and post IDs are unchanged, return figures stay unread. */
suspend fun AgentCapApi.publicActivity(): ApiResult<ThesesPage> =
  getJson("/api/theses?view=activity")
