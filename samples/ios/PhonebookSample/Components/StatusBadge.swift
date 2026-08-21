import SwiftUI

enum BadgeStatus {
    case success
    case error

    var label: String {
        switch self {
        case .success: return "Success"
        case .error: return "Error"
        }
    }

    var color: Color {
        switch self {
        case .success: return .green
        case .error: return .red
        }
    }
}

struct StatusBadge: View {
    let status: BadgeStatus

    var body: some View {
        Text(status.label)
            .font(.caption)
            .fontWeight(.semibold)
            .foregroundColor(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(status.color)
            .clipShape(Capsule())
    }
}

#Preview("Badge/Success", traits: .sizeThatFitsLayout) {
    StatusBadge(status: .success)
}

#Preview("Badge/Error", traits: .sizeThatFitsLayout) {
    StatusBadge(status: .error)
}
