package dev.stag.phonebook.sample

import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview

@Composable
fun PrimaryButton(
    text: String,
    enabled: Boolean,
    onClick: () -> Unit
) {
    Button(onClick = onClick, enabled = enabled) {
        Text(text)
    }
}

@Preview(name = "Button/Enabled")
@Composable
private fun PrimaryButtonEnabledPreview() {
    MaterialTheme {
        Surface {
            PrimaryButton(text = "Continue", enabled = true, onClick = {})
        }
    }
}

@Preview(name = "Button/Disabled")
@Composable
private fun PrimaryButtonDisabledPreview() {
    MaterialTheme {
        Surface {
            PrimaryButton(text = "Continue", enabled = false, onClick = {})
        }
    }
}
