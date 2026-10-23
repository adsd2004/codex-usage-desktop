import { describe, expect, it, vi } from "vitest";
import type { SessionReplayDetail } from "./api";
import type { ReplayItem } from "./session-conversation";
import { buildSearchDocuments, SessionSearchIndex } from "./session-search";
import openTerminal from "../../e2e/fixtures/open-terminal.json";

function turn(items: ReplayItem[]): SessionReplayDetail["turns"][number] {
  return { turnId: "search", startedAt: null, completedAt: null, durationMs: null, systemMessages: [], userMessages: [], assistantMessages: [], reasoningSummaries: [], toolCalls: [], patchResults: [], tokenEvents: [], errors: [], items };
}
const message = (text: string): ReplayItem => ({ kind: "message", role: "user", text, timestamp: null, source: "message" });
const yieldTask = async () => {};

describe("session data search", () => {
  it("returns occurrence positions in turn order, including collapsed exploration output", async () => {
    const documents = buildSearchDocuments([turn([message("Needle one needle")]), turn([{
      kind: "toolCall", callId: "read", name: "exec_command", arguments: '{"cmd":"cat notes.txt"}',
      output: '{"output":"hidden NEEDLE output","exit_code":0}', stderr: null,
      startedAt: null, completedAt: null, durationMs: null, status: "completed", isError: false,
    }])]);
    const index = new SessionSearchIndex(documents, "");
    expect(await index.search("needle", "timeline", yieldTask)).toMatchObject({ count: 3, index: 0, hit: { turnIndex: 0, blockIndex: 0, offset: 0 } });
    expect(index.select(1)).toMatchObject({ hit: { turnIndex: 0, offset: 11 }, matches: [
      { offsets: [0, 11], current: true }, { turnIndex: 1, offsets: [7], current: false },
    ] });
    expect(index.select(2)).toMatchObject({ hit: { turnIndex: 1, blockIndex: 0, entryIndex: 0, field: "output", offset: 7, text: "hidden NEEDLE output" } });
    expect(index.select(3).index).toBe(0);
    expect(index.select(-1).index).toBe(2);
    expect(await index.search("absent", "timeline", yieldTask)).toEqual({ count: 0, index: 0, hit: null, matches: [] });
  });

  it("searches literal punctuation and keeps original Unicode offsets", async () => {
    const index = new SessionSearchIndex(buildSearchDocuments([turn([message("İ😀 [a.*] 中文 [A.*]")])]), "");
    const result = await index.search("[a.*]", "timeline", yieldTask);
    expect(result).toMatchObject({ count: 2, hit: { offset: 4, highlightStart: 4, highlightEnd: 9 } });
    expect(index.select(1).hit?.offset).toBe(13);
    expect(await index.search("中文", "timeline", yieldTask)).toMatchObject({ hit: { offset: 10, highlightStart: 10, highlightEnd: 12 } });
    expect(await index.search("", "timeline", yieldTask)).toEqual({ count: 0, index: 0, hit: null, matches: [] });
  });

  it("returns bounded windows for deep hits in multi-megabyte lines and raw JSONL", async () => {
    const text = `${"x".repeat(2_000_000)}needle${"y".repeat(2_000_000)}needle`;
    const index = new SessionSearchIndex(buildSearchDocuments([turn([message(text)])]), `{"raw":"${text}"}`);
    const result = await index.search("needle", "timeline", yieldTask);
    expect(result).toMatchObject({ count: 2, hit: { offset: 2_000_000, windowStart: 1_996_000, length: text.length } });
    expect(result!.hit!.text.length).toBeLessThanOrEqual(8006);
    const last = index.select(1).hit!;
    expect(last.text.slice(last.highlightStart, last.highlightEnd)).toBe("needle");
    expect(last.text.length).toBeLessThanOrEqual(8006);
    expect(await index.search("needle", "raw", yieldTask)).toMatchObject({ count: 2, hit: { turnIndex: -1, field: "raw_jsonl", offset: 2_000_008 } });
  });

  it("bounds highlights for frequent queries while retaining every match for navigation", async () => {
    const text = "common ".repeat(20_000);
    const index = new SessionSearchIndex(buildSearchDocuments([turn([message(text), message(text)])]), text);
    for (const scope of ["timeline", "raw"] as const) {
      const count = scope === "timeline" ? 40_000 : 20_000;
      expect(await index.search("common", scope, yieldTask)).toMatchObject({ count, index: 0 });
      for (const selected of [0, 19_999, count - 1]) {
        const result = index.select(selected);
        expect(result).toMatchObject({ count, index: selected });
        expect(result.matches.reduce((sum, hit) => sum + hit.offsets.length, 0)).toBeLessThanOrEqual(200);
        expect(result.hit!.offsets).toContain(result.hit!.offset);
        expect(result.hit!.offset).toBe((selected % 20_000) * 7);
        expect(result.matches.filter((hit) => hit.current)).toEqual([result.hit]);
      }
      expect(index.select(count).index).toBe(0);
      expect(index.select(-1).index).toBe(count - 1);
    }
  });

  it("searches decoded native output and nested pages once, without base64 images", async () => {
    const native = openTerminal[1].payload.item!;
    const documents = buildSearchDocuments([turn([{
      kind: "toolCall", callId: "mixed", name: "exec", status: "completed",
      arguments: openTerminal[0].payload.input!, output: JSON.stringify(openTerminal[2].payload.output),
      stderr: null, startedAt: null, completedAt: null, durationMs: null, isError: false,
      commandExecutions: [{ callId: native.id, name: "exec_command", arguments: JSON.stringify({ cmd: native.command[2] }),
        output: JSON.stringify({ output: native.aggregated_output, exit_code: native.exit_code }),
        stderr: null, startedAt: null, completedAt: null, durationMs: null, status: "completed", isError: false }],
    }])]);
    const index = new SessionSearchIndex(documents, "");
    expect(await index.search("rtk proxy ps", "timeline", yieldTask)).toMatchObject({ count: 1, hit: { field: "command", text: "rtk proxy ps -Ao pid,ppid,etime,command" } });
    expect(await index.search("exec_command", "timeline", yieldTask)).toMatchObject({ count: 1, hit: { field: "sleep_tool" } });
    expect(await index.search("Apple Developer Documentation", "timeline", yieldTask)).toMatchObject({ count: 1, hit: { field: "output", context: "web" } });
    expect(documents.some((document) => document.text.includes("Warning: truncated output"))).toBe(false);
    const images = buildSearchDocuments([turn([{
      kind: "toolCall", callId: "image", name: "view_image", status: "completed", arguments: '{"path":"/tmp/needle.png"}',
      output: '[{"type":"image","image_url":"data:image/png;base64,needle"}]',
      stderr: null, startedAt: null, completedAt: null, durationMs: null, isError: false,
    }])]);
    expect(await new SessionSearchIndex(images, "").search("needle", "timeline", yieldTask)).toMatchObject({ count: 1 });
  });

  it("cancels stale scans cooperatively without overwriting the newer result", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now += 10);
    let resume!: () => void;
    const pause = new Promise<void>((resolve) => { resume = resolve; });
    try {
      const index = new SessionSearchIndex(buildSearchDocuments([turn([message("old old new")])]), "");
      const stale = index.search("old", "timeline", () => pause);
      expect(await index.search("new", "timeline", yieldTask)).toMatchObject({ count: 1, hit: { offset: 8 } });
      resume();
      expect(await stale).toBeNull();
      expect(index.select(0)).toMatchObject({ count: 1, hit: { offset: 8 } });
      const cancelled = index.search("old", "timeline", () => pause);
      index.cancel();
      expect(await cancelled).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
});
