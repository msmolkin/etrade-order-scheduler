# E*TRADE Trade Placer

## UI Rules

### Modals and Dialogs Must Use Inline Styles for Backgrounds

Tailwind background classes (e.g. `bg-slate-800`, `bg-black/60`) render as transparent in this app. **Always use explicit inline `style` attributes** for modal overlays and dialog panels:

```tsx
{/* Overlay */}
<div
  className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
  style={{ backgroundColor: 'rgba(0,0,0,0.6)', opacity: 1 }}
>
  {/* Dialog panel */}
  <div
    className="border border-slate-600 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl"
    style={{ backgroundColor: '#1e293b', opacity: 1 }}
  >
    ...
  </div>
</div>
```

Never rely on Tailwind classes alone for modal/dialog background colors. This has been a recurring issue.
