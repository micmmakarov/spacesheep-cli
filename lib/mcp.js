// Minimal MCP streamable-HTTP client. The CLI is an ordinary MCP client of the
// one remote server every other surface uses — there is no separate REST API
// to keep in sync with the tools.
"use strict";

const PROTOCOL = "2025-06-18";

class McpClient {
  constructor(origin, key) {
    this.url = `${origin.replace(/\/$/, "")}/mcp`;
    this.key = key;
    this.session = null;
    this.nextId = 1;
    this.ready = null;
  }

  async _post(body) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.key}`,
      "MCP-Protocol-Version": PROTOCOL,
    };
    if (this.session) headers["Mcp-Session-Id"] = this.session;
    const resp = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body) });
    const sid = resp.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (resp.status === 401) {
      const err = new Error("the server rejected this key — run `spacesheep login` again, or check SPACESHEEP_KEY");
      err.code = "EAUTH";
      throw err;
    }
    if (resp.status === 202 || resp.status === 204) return null;
    const ctype = resp.headers.get("content-type") || "";
    const text = await resp.text();
    if (!resp.ok) throw new Error(`server answered ${resp.status}: ${text.slice(0, 300)}`);
    if (ctype.includes("text/event-stream")) {
      // One JSON-RPC response arrives as SSE `data:` lines; take the one with our id.
      let last = null;
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          const msg = JSON.parse(line.slice(5).trim());
          if (msg && msg.id !== undefined && msg.id === body.id) return msg;
          last = msg;
        } catch {}
      }
      return last;
    }
    return text ? JSON.parse(text) : null;
  }

  async _init() {
    if (!this.ready) {
      this.ready = (async () => {
        await this._post({
          jsonrpc: "2.0", id: this.nextId++, method: "initialize",
          params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "spacesheep-cli", version: require("../package.json").version } },
        });
        await this._post({ jsonrpc: "2.0", method: "notifications/initialized" });
      })();
    }
    return this.ready;
  }

  /** Call a tool and return its first text block, JSON-parsed when it parses. */
  async call(name, args = {}) {
    await this._init();
    const msg = await this._post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } });
    if (!msg) throw new Error(`no response from ${name}`);
    if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
    const result = msg.result || {};
    const text = (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    let value = text;
    try { value = JSON.parse(text); } catch {}
    if (result.isError) {
      const err = new Error(typeof value === "string" ? value : value.error || text);
      err.code = "ETOOL";
      throw err;
    }
    return value;
  }
}

module.exports = { McpClient };
