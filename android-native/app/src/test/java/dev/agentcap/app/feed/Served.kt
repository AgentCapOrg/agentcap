package dev.agentcap.app.feed

import dev.agentcap.app.net.ApiResult
import dev.agentcap.app.net.Fixtures
import dev.agentcap.app.net.AgentCapApi
import dev.agentcap.app.net.answer
import dev.agentcap.app.net.apiFor
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer

/**
 * A PRODUCTION CAPTURE, THROUGH THE REAL CLIENT: served by a MockWebServer and
 * decoded by the same AgentCapApi the app runs, so a test over it is a test
 * over what the phone would have made of that answer.
 */
fun <T> served(fixture: String, call: suspend (AgentCapApi) -> ApiResult<T>): T {
  val server = MockWebServer()
  server.start()
  try {
    server.answer(Fixtures.text(fixture))
    val r = runBlocking { call(apiFor(server)) }
    return (r as? ApiResult.Ok)?.value ?: error("$fixture did not decode: $r")
  } finally {
    server.shutdown()
  }
}
