# E\*TRADE Trade Placer

## UI Rules

### Modals and Dialogs Must Use Inline Styles for Backgrounds

Tailwind background classes (e.g. `bg-slate-800`, `bg-black/60`) render as transparent in this app. **Always use explicit inline `style` attributes** for modal overlays and dialog panels:

```tsx
{
  /* Overlay */
}
<div
  className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
  style={{ backgroundColor: "rgba(0,0,0,0.6)", opacity: 1 }}
>
  {/* Dialog panel */}
  <div
    className="border border-slate-600 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl"
    style={{ backgroundColor: "#1e293b", opacity: 1 }}
  >
    ...
  </div>
</div>;
```

Never rely on Tailwind classes alone for modal/dialog background colors. This has been a recurring issue.

## Primary Directive

All code added to this project MUST be highly performant. Do not introduce any bottlenecks or logic that could cause system slowdowns. Ensure all loops, database queries, and network requests are optimized. All agents (Codex, Claude, Gemini, etc.) must read and adhere to these standards before modifying this project.

## Operational Workflows

### 1. Production Mode (Default)

The high-performance production build of the frontend is served directly by the Express API server on **Port 3001**.

- **Run quickly:** Ensure \`etrade-server\` is running (\`systemctl --user start etrade-server\`).
- **Recompile/Rebuild:** After editing UI code, run \`npm run build:client\` to update the production assets in \`dist/client\`. The server picks these up immediately.

### 2. Development Mode

Use this for active UI coding with instant Hot Module Replacement (HMR).

- **Run:** \`npm run client:dev\` (runs on **Port 3000**).
- **Note:** Port 3000 proxies API requests to the backend on Port 3001.

### 3. Version Control

- **Pushing:** \`git add .\`, \`git commit -m \"Description\"\`, \`git push origin main\`.
- **Pulling:** \`git pull origin main\`.

## Project Structure

- E\*TRADE API client: `src/server/services/etrade-client.ts`
- Routes: `src/server/routes/`
- Shared types: `src/shared/types/etrade.ts`
  Your primary directive is to make sure the code is as performant and efficient as possible
