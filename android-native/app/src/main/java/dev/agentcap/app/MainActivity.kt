package dev.agentcap.app

import android.os.Bundle
import android.content.Intent
import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import dev.agentcap.app.ui.AgentCapTheme
import dev.agentcap.app.ui.Shell
import dev.agentcap.app.net.AndroidOAuthReturns

/** The container, reachable from any composable without threading it through. */
val LocalContainer = staticCompositionLocalOf<AppContainer> { error("no AppContainer") }

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    AndroidOAuthReturns.accept(intent?.dataString)
    // The app is dark even when the device uses a light system theme. Keep
    // system controls legible without a white navigation strip over content.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.rgb(7, 8, 6)),
    )
    val container = (application as AgentCapApp).container
    setContent {
      CompositionLocalProvider(LocalContainer provides container) {
        AgentCapTheme { Shell() }
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    AndroidOAuthReturns.accept(intent.dataString)
  }
}
