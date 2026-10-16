import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { buildRuntimeOptions, type LaunchOptions } from "../src/pi-launch";
import {
  FUSION_EXECUTOR_ID,
  FUSION_ID,
  FUSION_NAME,
  FUSION_PLANNER_ID,
} from "../src/fusion";
import { PROVIDER_NAME } from "../src/provider";
import { resolveFreePiScope } from "../src/provider-lock";

const CATALOG_MODELS = [
  { id: FUSION_EXECUTOR_ID, name: "DeepSeek V4 Flash" },
  { id: FUSION_PLANNER_ID, name: "Gemini 4 Argon Flex" },
];

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sseFrame(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function toolCallSse(model: string, callId: string, toolName: string, args: unknown): string {
  const base = { id: `response-${callId}`, object: "chat.completion.chunk", created: 1, model };
  const start = {
    ...base,
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        content: null,
        tool_calls: [{
          index: 0,
          id: callId,
          type: "function",
          function: { name: toolName, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: null,
    }],
  };
  const end = { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
  return sseFrame(start) + sseFrame(end) + "data: [DONE]\n\n";
}

function finalTextSse(model: string, responseId: string): string {
  const base = { id: responseId, object: "chat.completion.chunk", created: 2, model };
  const start = {
    ...base,
    choices: [{ index: 0, delta: { role: "assistant", content: "Fusion complete" }, finish_reason: null }],
  };
  const end = { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  return sseFrame(start) + sseFrame(end) + "data: [DONE]\n\n";
}

function trackedResponse(
  body: string,
  onClose: () => void,
  status = 200,
  contentType = "text/event-stream",
): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const finish = () => {
    if (!closed) {
      closed = true;
      onClose();
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await Bun.sleep(10);
      controller.enqueue(encoder.encode(body));
      controller.close();
      finish();
    },
    cancel() {
      finish();
    },
  });
  return new Response(stream, { status, headers: { "content-type": contentType } });
}

async function createFusionSession(baseUrl: string, cwd: string, sessionId: string) {
  const opts: LaunchOptions = {
    baseUrl,
    jwt: "test-jwt",
    agentDir: tempDir("free-pi-fusion-agentdir-"),
    models: CATALOG_MODELS,
  };
  const { settingsManager, resourceLoaderOptions, tools } = buildRuntimeOptions(opts, sessionId);
  const services = await createAgentSessionServices({
    cwd,
    agentDir: opts.agentDir,
    settingsManager,
    resourceLoaderOptions,
  });
  const scopedModels = resolveFreePiScope(
    services.modelRuntime,
    PROVIDER_NAME,
    CATALOG_MODELS.map((model) => model.id),
  );
  const fusionModel = services.modelRuntime.getModel(PROVIDER_NAME, FUSION_ID);
  if (!fusionModel) throw new Error("Fusion was not registered in the production model runtime");
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    tools: [...tools],
    scopedModels,
  });
  return { session, fusionModel, scopedModels };
}

describe("Fusion production session routing", () => {
  test("selects Fusion, hands off after a successful write, then replans on the next user message", async () => {
    let openStreams = 0;
    let maxOpenStreams = 0;
    const requestModels: string[] = [];
    const cwd = tempDir("free-pi-fusion-cwd-");
    const filePath = join(cwd, "fusion-output.txt");

    const stub = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
          return new Response("not found", { status: 404 });
        }
        openStreams++;
        maxOpenStreams = Math.max(maxOpenStreams, openStreams);
        const closeStream = () => {
          openStreams--;
        };
        try {
          const body = await req.json() as { model?: string };
          const model = body.model ?? "";
          requestModels.push(model);
          const responseBody = requestModels.length === 1
            ? toolCallSse(model, "fusion-write", "write", { path: filePath, content: "written by Fusion\n" })
            : finalTextSse(model, `fusion-response-${requestModels.length}`);
          return trackedResponse(responseBody, closeStream);
        } catch (error) {
          closeStream();
          throw error;
        }
      },
    });

    let disposeSession: (() => void) | undefined;
    try {
      const { session, fusionModel, scopedModels } = await createFusionSession(
        stub.url.toString().replace(/\/$/, ""),
        cwd,
        "session-fusion-routing",
      );
      disposeSession = () => session.dispose();
      expect(scopedModels.filter(({ model }) => model.id === FUSION_ID)).toHaveLength(1);
      expect(fusionModel.name).toBe(FUSION_NAME);
      await session.setModel(fusionModel);
      expect(session.model?.id).toBe(FUSION_ID);

      await session.prompt("Write the requested file with the write tool, then finish.");
      await session.prompt("Give me one brief follow-up.");
      await session.waitForIdle();

      expect(readFileSync(filePath, "utf8")).toBe("written by Fusion\n");
      expect(requestModels).toEqual([
        FUSION_PLANNER_ID,
        FUSION_EXECUTOR_ID,
        FUSION_PLANNER_ID,
      ]);
      expect(
        session.state.messages.flatMap((message) => message.role === "assistant" ? [message.model] : []),
      ).toEqual([FUSION_PLANNER_ID, FUSION_EXECUTOR_ID, FUSION_PLANNER_ID]);
      expect(session.model?.id).toBe(FUSION_ID);
      expect(maxOpenStreams).toBe(1);
      expect(openStreams).toBe(0);
    } finally {
      disposeSession?.();
      stub.stop(true);
    }
  }, 20_000);

  test("a planner capacity failure is retried by pi on the executor", async () => {
    let openStreams = 0;
    let maxOpenStreams = 0;
    const requestModels: string[] = [];
    const retryStarts: number[] = [];
    const retryEnds: boolean[] = [];
    const cwd = tempDir("free-pi-fusion-retry-cwd-");

    const stub = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
          return new Response("not found", { status: 404 });
        }
        openStreams++;
        maxOpenStreams = Math.max(maxOpenStreams, openStreams);
        const closeStream = () => {
          openStreams--;
        };
        try {
          const body = await req.json() as { model?: string };
          const model = body.model ?? "";
          requestModels.push(model);
          if (requestModels.length === 1) {
            const errorEnvelope = JSON.stringify({
              code: "upstream_error",
              message: "upstream responded 503",
              error: {
                message: "upstream responded 503",
                code: "upstream_error",
                type: "free_pi_error",
              },
            });
            return trackedResponse(errorEnvelope, closeStream, 502, "application/json");
          }
          return trackedResponse(finalTextSse(model, "fusion-retry-success"), closeStream);
        } catch (error) {
          closeStream();
          throw error;
        }
      },
    });

    let disposeSession: (() => void) | undefined;
    try {
      const { session, fusionModel } = await createFusionSession(
        stub.url.toString().replace(/\/$/, ""),
        cwd,
        "session-fusion-retry",
      );
      disposeSession = () => session.dispose();
      session.subscribe((event) => {
        if (event.type === "auto_retry_start") retryStarts.push(event.attempt);
        if (event.type === "auto_retry_end") retryEnds.push(event.success);
      });
      await session.setModel(fusionModel);
      await session.prompt("Ask the planner to make a small plan.");
      await session.waitForIdle();

      expect(requestModels).toEqual([FUSION_PLANNER_ID, FUSION_EXECUTOR_ID]);
      expect(retryStarts).toEqual([1]);
      expect(retryEnds).toEqual([true]);
      expect(
        session.state.messages.flatMap((message) => message.role === "assistant" ? [message.model] : []),
      ).toEqual([FUSION_EXECUTOR_ID]);
      expect(session.model?.id).toBe(FUSION_ID);
      expect(maxOpenStreams).toBe(1);
      expect(openStreams).toBe(0);
    } finally {
      disposeSession?.();
      stub.stop(true);
    }
  }, 20_000);
});
