import SwiftUI

struct PrimaryButton: View {
    let title: String
    let isEnabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.headline)
                .foregroundColor(.white)
                .frame(maxWidth: .infinity)
                .padding()
                .background(isEnabled ? Color.blue : Color.gray)
                .cornerRadius(10)
        }
        .disabled(!isEnabled)
        .padding(.horizontal)
    }
}

#Preview("Button/Enabled", traits: .sizeThatFitsLayout) {
    PrimaryButton(title: "Continue", isEnabled: true, action: {})
}

#Preview("Button/Disabled", traits: .sizeThatFitsLayout) {
    PrimaryButton(title: "Continue", isEnabled: false, action: {})
}
