# AutoZCoder desktop design

The rewrite is a local developer tool. The interface should feel like a native macOS utility and stay readable on Windows and Linux. Decoration is secondary to tables, status, and logs.

## Principles

- One job per screen: overview, accounts, models, usage, settings.
- Show live gateway data. Empty states say what is missing.
- Tokens are hinted, never displayed in full.
- Light and dark themes share the same spacing and type scale.
- Motion is limited to color changes. No decorative animation.

## Color

| Token | Light | Dark |
| --- | --- | --- |
| bg | `#f5f5f7` | `#1c1c1e` |
| surface | `#ffffff` | `#2c2c2e` |
| surface-2 | `#f0f0f3` | `#3a3a3c` |
| ink | `#1d1d1f` | `#f5f5f7` |
| muted | `#6e6e73` | `#a1a1a6` |
| line | `rgba(0,0,0,.08)` | `rgba(255,255,255,.08)` |
| accent | `#0071e3` | `#0a84ff` |
| ok | `#248a3d` | `#30d158` |
| warn | `#b25000` | `#ffd60a` |
| danger | `#d70015` | `#ff453a` |

## Type

System UI font: `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`.

| Use | Size | Weight |
| --- | --- | --- |
| Window title | 13px | 600 |
| Section label | 12px | 400 |
| Body | 13px | 400 |
| Metric | 24px | 600 |

Numbers in tables use tabular figures.

## Spacing

4, 8, 12, 16, 20, 24. Page padding is 20. Cards use 16. Sidebar width is 224.

## Components

- Sidebar navigation with the current item filled in the accent color.
- Top toolbar: page title, connection dot, theme toggle.
- Cards for single metrics.
- Tables: left-aligned text, right-aligned actions, horizontal scroll below 780px.
- Password fields for keys and access tokens.
- Empty rows explain the next action.
- Error text uses the danger color and the gateway's message.

## Layout

The window minimum is 780 by 560. The sidebar stays visible. The content column scrolls. Hash routing keeps the packaged `file://` build working.

## Accessibility

- Buttons and inputs use the system font and at least 13px text.
- Color is not the only status signal; health text is also shown.
- Focus remains on native controls.
- The renderer has no Node.js access. External links open in the system browser.

## Platform

- macOS: hidden inset title is not required; the standard frame is used.
- Windows and Linux: the same layout, system font fallback, single-instance lock.
- Theme follows the OS on first launch and then the in-app toggle.
