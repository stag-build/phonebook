# Naming convention

Phonebook turns each preview into a `{ component, state }` pair with no required annotation. It parses the preview's display name first, then falls back to the function/file name. Grouping precedence (from `src/naming.ts`):

1. A display name containing `/` splits into `component/state`.
2. A display name without `/` becomes the state; the component comes from the function name.
3. No display name: the function name (minus a leading/trailing "Preview") is the component, and the state is `"Default"`.

## Slash-named previews

**Android** (`samples/android/app/src/main/java/dev/stag/phonebook/sample/PrimaryButton.kt`):

```kotlin
@Preview(name = "Button/Enabled")
@Composable
private fun PrimaryButtonEnabledPreview() { ... }
```

**iOS** (`samples/ios/PhonebookSample/Components/PrimaryButton.swift`):

```swift
#Preview("Button/Enabled", traits: .sizeThatFitsLayout) {
    PrimaryButton(title: "Continue", isEnabled: true, action: {})
}
```

Both produce component **"Button"**, state **"Enabled"**. A second preview named `"Button/Disabled"` becomes state **"Disabled"** on the same component card.

## Unnamed previews

**Android** `UserCardPreview` (no `name =`) in `UserCard.kt` becomes component **"User Card"** (from the function name, "Preview" suffix stripped, camel-case spaced), state **"Default"**.

**iOS**, an unnamed `#Preview { ContentView() }` gets an auto display name from SnapshotPreviews like `"At line #14"` — Phonebook recognizes that pattern and treats it as unnamed, falling back to the container view's name. In the sample this becomes component **"Content View"**, state **"Default"**.

## Dark mode

**Android**: a preview with `uiMode = Configuration.UI_MODE_NIGHT_YES` and no display name is treated as the `"Dark"` state of its component, and `theme: "dark"` is recorded. Phonebook also strips a trailing `Dark`/`Night` suffix from the function name so `UserCardDarkPreview` groups under **"User Card"**, not a separate "User Card Dark" component:

```kotlin
@Preview(uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun UserCardDarkPreview() { ... }
```

**iOS**: dark mode isn't inferred from the function/preview name — it's read from `.preferredColorScheme(.dark)` via the JSON sidecar SnapshotPreviews writes next to each screenshot (`context.preview.preferred_color_scheme`). Give the preview an explicit `"Component/Dark"` name so the state label is meaningful:

```swift
#Preview("UserCard/Dark", traits: .sizeThatFitsLayout) {
    UserCard(name: "Ada Lovelace", email: "ada@example.com")
        .preferredColorScheme(.dark)
}
```

This records component **"User Card"**, state **"Dark"**, `theme: "dark"`.

## Component name spacing

Slash-named and function-derived component names are run through camel-case spacing: `"UserCard"` → `"User Card"`, `"URLBar"` → `"URL Bar"` (acronym runs are kept together). This applies whether the name came from a `Button/Disabled`-style display name or from a bare function name like `PrimaryButtonPreview`.

## iOS: prefer `.sizeThatFitsLayout`

Every preview in the sample app uses `traits: .sizeThatFitsLayout`:

```swift
#Preview("Badge/Success", traits: .sizeThatFitsLayout) {
    StatusBadge(status: .success)
}
```

Without it, SnapshotPreviews renders the view at full device size, and a small component like a badge or button ends up as a tiny image on a mostly-blank screenshot. `.sizeThatFitsLayout` renders the view fit-to-content instead, which is what you want for a component gallery.
