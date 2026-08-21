import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(spacing: 16) {
            PrimaryButton(title: "Continue", isEnabled: true, action: {})
            StatusBadge(status: .success)
            UserCard(name: "Ada Lovelace", email: "ada@example.com")
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
