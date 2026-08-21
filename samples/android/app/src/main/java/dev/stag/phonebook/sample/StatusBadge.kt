package dev.stag.phonebook.sample

import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp

@Composable
fun StatusBadge(text: String, isSuccess: Boolean) {
    val color = if (isSuccess) Color(0xFF2E7D32) else Color(0xFFC62828)
    Surface(color = color, shape = RoundedCornerShape(50)) {
        Text(
            text = text,
            color = Color.White,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp)
        )
    }
}

@Preview(name = "Badge/Success")
@Composable
private fun StatusBadgeSuccessPreview() {
    MaterialTheme {
        StatusBadge(text = "Active", isSuccess = true)
    }
}

@Preview(name = "Badge/Error")
@Composable
private fun StatusBadgeErrorPreview() {
    MaterialTheme {
        StatusBadge(text = "Failed", isSuccess = false)
    }
}
