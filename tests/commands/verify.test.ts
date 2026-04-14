import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanupTmpDir, createTmpDir } from "../helpers.js";

const loadConfigMock = vi.fn();
const loadScanOptionsMock = vi.fn();
const scanProjectMock = vi.fn();
const flattenBottomUpMock = vi.fn();
const filterByMinTokensMock = vi.fn();
const runVerifyMock = vi.fn();

vi.mock("../../src/utils/config.js", () => ({
  loadConfig: loadConfigMock,
  getVerifyCommand: vi.fn(() => "npm test"),
}));

vi.mock("../../src/utils/scan-options.js", () => ({
  loadScanOptions: loadScanOptionsMock,
}));

vi.mock("../../src/core/scanner.js", () => ({
  scanProject: scanProjectMock,
  flattenBottomUp: flattenBottomUpMock,
}));

vi.mock("../../src/utils/tokens.js", () => ({
  filterByMinTokens: filterByMinTokensMock,
}));

vi.mock("../../src/verify/orchestrator.js", () => ({
  runVerify: runVerifyMock,
  VERIFY_KINDS: ["test", "typecheck", "lint"],
}));

const { verifyCommand } = await import("../../src/commands/verify.js");

let tmpDir: string;
let originalIsTTY: PropertyDescriptor | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await createTmpDir();
  process.exitCode = undefined;

  loadConfigMock.mockResolvedValue({
    min_tokens: 0,
    verify: {
      test: "npm test",
    },
  });
  loadScanOptionsMock.mockResolvedValue({});
  scanProjectMock.mockResolvedValue({
    path: tmpDir,
    relativePath: ".",
    files: ["index.ts"],
    children: [],
  });
  flattenBottomUpMock.mockResolvedValue([
    { path: tmpDir, relativePath: ".", files: ["index.ts"], children: [] },
  ]);
  filterByMinTokensMock.mockResolvedValue({
    dirs: [{ path: tmpDir, relativePath: "." }],
  });
  runVerifyMock.mockResolvedValue({
    scopes: [{ scope: ".", status: "ok", ran: [], skipped: [] }],
    totals: { passing: 0, failing: 0, clean: 0, errors: 0, unknown: 0 },
  });

  originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
});

afterEach(async () => {
  if (originalIsTTY) {
    Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
  }
  vi.restoreAllMocks();
  await cleanupTmpDir(tmpDir);
  process.exitCode = undefined;
});

describe("verifyCommand", () => {
  it("skips the first-run prompt in --json mode on a TTY and emits pure JSON", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(
      verifyCommand({ path: tmpDir, json: true }),
    ).rejects.toThrow("process.exit(0)");

    expect(runVerifyMock).toHaveBeenCalledTimes(1);
    expect(() => JSON.parse(chunks.join(""))).not.toThrow();
  });

  it("keeps the non-TTY JSON refusal path when the first-run marker is absent", async () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${code})`);
    });

    await expect(
      verifyCommand({ path: tmpDir, json: true }),
    ).rejects.toThrow("process.exit(2)");

    expect(runVerifyMock).not.toHaveBeenCalled();
    expect(JSON.parse(chunks.join(""))).toMatchObject({
      error: "tty_required",
    });
  });
});
