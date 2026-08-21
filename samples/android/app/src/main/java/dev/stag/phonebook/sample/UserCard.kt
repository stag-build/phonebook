package dev.stag.phonebook.sample

import android.content.res.Configuration
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp

@Composable
fun UserCard(name: String, subtitle: String) {
    Card {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(text = name, style = MaterialTheme.typography.titleMedium)
            Text(text = subtitle, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Preview
@Composable
private fun UserCardPreview() {
    MaterialTheme {
        UserCard(name = "Ada Lovelace", subtitle = "ada@example.com")
    }
}

@Preview(uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun UserCardDarkPreview() {
    MaterialTheme {
        UserCard(name = "Ada Lovelace", subtitle = "ada@example.com")
    }
}
