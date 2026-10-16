// Minimal stdio MCP server for tests: newline-delimited JSON-RPC, one tool
// (`echo`), no network. Run with `node stub-mcp-server.mjs`.
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.id === undefined) return; // notification
  switch (req.method) {
    case "initialize":
      send({
        id: req.id,
        result: {
          protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "stub", version: "1.0.0" },
        },
      });
      break;
    case "tools/list":
      send({
        id: req.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo the given text back.",
              inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            },
          ],
        },
      });
      break;
    case "tools/call":
      send({ id: req.id, result: { content: [{ type: "text", text: `echo:${req.params?.arguments?.text ?? ""}` }] } });
      break;
    case "ping":
      send({ id: req.id, result: {} });
      break;
    default:
      send({ id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } });
  }
});
