---
name: browser-tools-mcp-safer-macos
description: Safer macOS setup and usage for AgentDesk Browser-Tools MCP (browser-tools-mcp, browser-tools-server). Use when setting up or using Browser-Tools MCP, AgentDesk browser tools, MCP Chrome extension, or when the user mentions browser-tools server, port 3025, or mcp.json browser config.
---

# Browser-Tools MCP — Safer macOS Setup

When helping set up or run **Browser-Tools MCP** on macOS, follow this safer configuration so the server is not exposed on the network and versions are pinned.

## 1. MCP config (`~/.cursor/mcp.json`)

Pin exact versions and use stdio:

```json
{
  "mcpServers": {
    "browser-tools": {
      "command": "npx",
      "args": ["-y", "@agentdeskai/browser-tools-mcp@1.2.0", "--stdio"]
    }
  }
}
```

Do not use unpinned or `latest` for this MCP.

## 2. Run the server localhost-only

Start the browser-tools server bound to loopback so it is not reachable from the LAN:

```bash
SERVER_HOST=127.0.0.1 PORT=3025 npx -y @agentdeskai/browser-tools-server@1.2.0
```

Keep this process running in a dedicated terminal while using the tools. Default `SERVER_HOST=0.0.0.0` exposes the HTTP API on all interfaces—avoid that on shared or untrusted networks.

## 3. Optional hardening

- **Firewall**: Block inbound TCP 3025 except from localhost if the server might ever be started without `SERVER_HOST=127.0.0.1`.
- **Extension**: In the BrowserTools Chrome extension, turn off “auto-paste” or other powerful features unless needed (reduces reliance on AppleScript execution).
- **Updates**: Before upgrading from `@1.2.0`, re-check release notes and consider a quick security review of the new version.

## 4. Quick check

After starting the server with `SERVER_HOST=127.0.0.1`:

```bash
curl -s http://127.0.0.1:3025/.identity
```

Expected: JSON with `"signature": "mcp-browser-connector-24x7"`. If this responds when binding to `127.0.0.1` only, the server is not listening on external interfaces.

## When suggesting setup

- Prefer suggesting the one-line `SERVER_HOST=127.0.0.1 PORT=3025 npx ...` command over the default.
- If the user reports “server not found” or connection issues, remind them the server must be running in a separate terminal and that the Chrome extension must be loaded and connected to the same machine where the server runs.
