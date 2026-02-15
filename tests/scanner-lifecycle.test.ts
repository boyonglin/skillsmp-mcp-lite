import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();

vi.mock("child_process", () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

function healthOkResponse(ok = true): Response {
  return { ok } as Response;
}

function createMockChildProcess() {
  return {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    killed: false,
    exitCode: null,
    pid: 1234,
  };
}

function createEventfulChildProcess() {
  const streamHandlers: Record<string, ((data: Buffer) => void) | undefined> =
    {};
  const processHandlers: Record<string, ((arg?: unknown) => void) | undefined> =
    {};

  return {
    child: {
      stdout: {
        on: vi.fn((event: string, cb: (data: Buffer) => void) => {
          streamHandlers[`stdout:${event}`] = cb;
        }),
      },
      stderr: {
        on: vi.fn((event: string, cb: (data: Buffer) => void) => {
          streamHandlers[`stderr:${event}`] = cb;
        }),
      },
      on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
        processHandlers[event] = cb;
      }),
      kill: vi.fn(),
      killed: false,
      exitCode: null,
      pid: 5678,
    },
    streamHandlers,
    processHandlers,
  };
}

describe("ensureScannerApi", () => {
  const originalEnv = { ...process.env };
  const originalMaxListeners = process.getMaxListeners();

  beforeAll(() => {
    process.setMaxListeners(50);
  });

  afterAll(() => {
    process.setMaxListeners(originalMaxListeners);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  it("returns external scanner URL when healthy", async () => {
    process.env.SKILL_SCANNER_API_URL = "http://scanner.local:9000";
    delete process.env.SKILL_SCANNER_API_PORT;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthOkResponse(true)));

    const { ensureScannerApi } = await import("../src/scanner/lifecycle.js");
    const url = await ensureScannerApi();

    expect(url).toBe("http://scanner.local:9000");
  });

  it("returns empty string when external scanner URL is unhealthy", async () => {
    process.env.SKILL_SCANNER_API_URL = "http://scanner.local:9000";

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthOkResponse(false)));

    const { ensureScannerApi } = await import("../src/scanner/lifecycle.js");
    const url = await ensureScannerApi();

    expect(url).toBe("");
  });

  it("returns managed URL when localhost health endpoint is already healthy", async () => {
    delete process.env.SKILL_SCANNER_API_URL;
    process.env.SKILL_SCANNER_API_PORT = "8123";

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthOkResponse(true)));

    const { ensureScannerApi } = await import("../src/scanner/lifecycle.js");
    const url = await ensureScannerApi();

    expect(url).toBe("http://localhost:8123");
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns empty string when uvx cannot be found during auto-start", async () => {
    delete process.env.SKILL_SCANNER_API_URL;
    delete process.env.SKILL_SCANNER_API_PORT;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthOkResponse(false)));

    spawnSyncMock.mockReturnValue({ error: new Error("not found"), status: 1 });

    const { ensureScannerApi } = await import("../src/scanner/lifecycle.js");
    const url = await ensureScannerApi();

    expect(url).toBe("");
    expect(spawnSyncMock).toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("auto-starts scanner via uvx and returns managed URL when startup succeeds", async () => {
    delete process.env.SKILL_SCANNER_API_URL;
    process.env.SKILL_SCANNER_API_PORT = "8124";

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(healthOkResponse(false))
        .mockResolvedValueOnce(healthOkResponse(true))
    );

    spawnSyncMock.mockReturnValue({ status: 0 });
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const { ensureScannerApi } = await import("../src/scanner/lifecycle.js");
    const url = await ensureScannerApi();

    expect(url).toBe("http://localhost:8124");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent startup attempts", async () => {
    delete process.env.SKILL_SCANNER_API_URL;
    process.env.SKILL_SCANNER_API_PORT = "8125";

    let healthCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        healthCalls += 1;
        return healthCalls < 3
          ? healthOkResponse(false)
          : healthOkResponse(true);
      })
    );

    spawnSyncMock.mockReturnValue({ status: 0 });
    spawnMock.mockReturnValue(createMockChildProcess());

    const { ensureScannerApi } = await import("../src/scanner/lifecycle.js");
    const [a, b] = await Promise.all([ensureScannerApi(), ensureScannerApi()]);

    expect(a).toBe("http://localhost:8125");
    expect(b).toBe("http://localhost:8125");
    expect(spawnMock).toHaveBeenCalled();
  });

  it("reuses already-ready managed process when healthy", async () => {
    delete process.env.SKILL_SCANNER_API_URL;
    process.env.SKILL_SCANNER_API_PORT = "8126";

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(healthOkResponse(false))
      .mockResolvedValueOnce(healthOkResponse(true));
    vi.stubGlobal("fetch", fetchMock);

    spawnSyncMock.mockReturnValue({ status: 0 });
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const { ensureScannerApi } = await import("../src/scanner/lifecycle.js");

    const first = await ensureScannerApi();
    expect(first).toBe("http://localhost:8126");
    const spawnCallsAfterFirst = spawnMock.mock.calls.length;

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(healthOkResponse(true));

    const second = await ensureScannerApi();
    expect(second).toBe("http://localhost:8126");
    expect(spawnMock.mock.calls.length).toBe(spawnCallsAfterFirst);
  });

  it("kills stale managed process when unhealthy and recovers", async () => {
    delete process.env.SKILL_SCANNER_API_URL;
    process.env.SKILL_SCANNER_API_PORT = "8127";

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(healthOkResponse(false))
      .mockResolvedValueOnce(healthOkResponse(true));
    vi.stubGlobal("fetch", fetchMock);

    spawnSyncMock.mockReturnValue({ status: 0 });
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const { ensureScannerApi } = await import("../src/scanner/lifecycle.js");

    await ensureScannerApi();

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(healthOkResponse(false))
      .mockResolvedValueOnce(healthOkResponse(true));

    const recovered = await ensureScannerApi();

    expect(recovered).toBe("http://localhost:8127");
    expect(child.kill).toHaveBeenCalled();
  });

  it("returns empty string when auto-start throws unexpectedly", async () => {
    delete process.env.SKILL_SCANNER_API_URL;
    process.env.SKILL_SCANNER_API_PORT = "8128";

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthOkResponse(false)));

    spawnSyncMock.mockReturnValue({ status: 0 });
    spawnMock.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    const { ensureScannerApi } = await import("../src/scanner/lifecycle.js");
    const url = await ensureScannerApi();

    expect(url).toBe("");
  });

  it("executes child stdout/stderr and process event handlers", async () => {
    delete process.env.SKILL_SCANNER_API_URL;
    process.env.SKILL_SCANNER_API_PORT = "8129";

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(healthOkResponse(false))
        .mockResolvedValueOnce(healthOkResponse(true))
    );

    spawnSyncMock.mockReturnValue({ status: 0 });
    const eventful = createEventfulChildProcess();
    spawnMock.mockReturnValue(eventful.child);

    const { ensureScannerApi } = await import("../src/scanner/lifecycle.js");
    await ensureScannerApi();

    eventful.streamHandlers["stdout:data"]?.(Buffer.from("ready"));
    eventful.streamHandlers["stderr:data"]?.(Buffer.from("warn"));
    eventful.processHandlers.exit?.(0);
    eventful.processHandlers.error?.(new Error("child error"));

    expect(eventful.child.stdout.on).toHaveBeenCalled();
    expect(eventful.child.stderr.on).toHaveBeenCalled();
  });

  it("shutdown on process exit falls back to child.kill when taskkill fails", async () => {
    delete process.env.SKILL_SCANNER_API_URL;
    process.env.SKILL_SCANNER_API_PORT = "8130";

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(healthOkResponse(false))
        .mockResolvedValueOnce(healthOkResponse(true))
    );

    spawnSyncMock.mockImplementation((command: string) => {
      if (command === "taskkill") {
        return { status: 1 };
      }
      return { status: 0 };
    });

    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    const { ensureScannerApi } = await import("../src/scanner/lifecycle.js");
    await ensureScannerApi();

    process.emit("exit", 0);

    expect(child.kill).toHaveBeenCalled();
  });
});
