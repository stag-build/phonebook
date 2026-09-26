package dev.stag.phonebook.sample

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview

@Preview(name = "Viewport/Default")
@Composable
private fun DefaultViewportProbe() {
    Box(Modifier.fillMaxSize().background(Color.Red))
}

@Preview(name = "Viewport/Size", widthDp = 240, heightDp = 400)
@Composable
private fun SizeViewportProbe() {
    Box(Modifier.fillMaxSize().background(Color.Blue))
}

@Preview(name = "Viewport/Device", device = "spec:width=240dp,height=400dp,dpi=160")
@Composable
private fun DeviceViewportProbe() {
    Box(Modifier.fillMaxSize().background(Color.Green))
}
