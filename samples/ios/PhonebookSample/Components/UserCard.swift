import SwiftUI

struct UserCard: View {
    let name: String
    let email: String

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(Color.accentColor)
                .frame(width: 44, height: 44)
                .overlay(
                    Text(String(name.prefix(1)))
                        .font(.headline)
                        .foregroundColor(.white)
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(.body)
                    .fontWeight(.medium)
                Text(email)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Spacer()
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .cornerRadius(12)
        .padding(.horizontal)
    }
}

#Preview("UserCard/Default", traits: .sizeThatFitsLayout) {
    UserCard(name: "Ada Lovelace", email: "ada@example.com")
}

#Preview("UserCard/Dark", traits: .sizeThatFitsLayout) {
    UserCard(name: "Ada Lovelace", email: "ada@example.com")
        .preferredColorScheme(.dark)
}
