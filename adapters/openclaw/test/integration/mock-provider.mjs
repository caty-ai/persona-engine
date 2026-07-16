import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import http from "node:http";

const port = Number(process.argv[2]);
const logPath = process.argv[3];
const expectedBlock = Buffer.from(process.env.PERSONA_TEST_BLOCK_BASE64 ?? "", "base64").toString("utf8");

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part && typeof part === "object" && typeof part.text === "string" ? part.text : "").join("");
}

function logRequest(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemPrompt = messages.filter((message) => message?.role === "system").map((message) => textOf(message.content)).join("\n\n");
  const userPrompt = [...messages].reverse().find((message) => message?.role === "user");
  const tools = Array.isArray(body.tools) ? body.tools.map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean) : [];
  const blockPresent = expectedBlock.length > 0 && systemPrompt.includes(expectedBlock);
  appendFileSync(logPath, `${JSON.stringify({
    userPrompt: textOf(userPrompt?.content),
    toolNames: tools,
    personaBlockBytes: blockPresent ? Buffer.byteLength(expectedBlock) : 0,
    personaBlockSha256: blockPresent ? createHash("sha256").update(expectedBlock).digest("hex") : createHash("sha256").update("").digest("hex"),
  })}\n`);
}

function completion(model) {
  return {
    id: "chatcmpl-persona-integration",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "mock reply" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const server = http.createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "mock-1", object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || !request.url?.includes("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    logRequest(body);
    const model = body.model || "mock-1";
    if (body.stream) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = (delta, finishReason = null) => `data: ${JSON.stringify({
        id: "chatcmpl-persona-integration",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;
      response.write(chunk({ role: "assistant", content: "mock reply" }));
      response.write(chunk({}, "stop"));
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(completion(model)));
  });
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`ready:${port}\n`));

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
