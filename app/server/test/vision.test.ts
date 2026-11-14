import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { AnthropicApiVision, ClaudeCliVision, createVision } from "../src/models/vision.js";

function fakeChild(output: string) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end(): void };
    kill(): void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.stdin = {
    end() {
      queueMicrotask(() => {
        child.stdout.emit("data", output);
        child.emit("close", 0);
      });
    },
  };
  return child;
}

describe("Claude provider selection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps API credentials out of Claude CLI unless the API provider is selected", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-api-key");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "test-auth-token");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://api.example.test");
    vi.stubEnv("VISION_PROVIDER", "");
    let childEnv: NodeJS.ProcessEnv | undefined;
    spawnMock.mockImplementation((_command, _args, options) => {
      childEnv = options.env;
      return fakeChild('{"structured_output":{"answer":"ok"}}');
    });

    const cli = createVision();
    expect(cli).toBeInstanceOf(ClaudeCliVision);
    await cli.ask({ system: "system", prompt: `unique-${Date.now()}`, schema: {} });

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(childEnv).toBeDefined();
    expect(childEnv?.PATH).toBe(process.env.PATH);
    expect(childEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(childEnv).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(childEnv).not.toHaveProperty("ANTHROPIC_BASE_URL");

    process.env.VISION_PROVIDER = "anthropic-api";
    expect(createVision()).toBeInstanceOf(AnthropicApiVision);
  });
});
