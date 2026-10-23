// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { SessionReplayDetail } from "@/lib/api";
import type { SessionSearchRequest, SessionSearchResponse } from "@/lib/session-search";
import { buildSearchDocuments, SessionSearchIndex } from "@/lib/session-search";
import { SessionSearchContext, SessionSearchText, SessionSearchToolbar, type SessionSearchHandle } from "./session-search";

class SearchWorker {
  static instances: SearchWorker[] = [];
  onmessage: ((event: MessageEvent<SessionSearchResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn<(message: SessionSearchRequest) => void>();
  terminate = vi.fn();
  constructor() { SearchWorker.instances.push(this); }
  reply(requestId: number, index = 0) {
    this.onmessage?.(new MessageEvent<SessionSearchResponse>("message", { data: { requestId, count: 3, index, hit: null, matches: [] } }));
  }
  latestRequest() {
    return this.postMessage.mock.calls.map(([request]) => request).findLast((request) => request.type === "search" || request.type === "select")!;
  }
}

const detail: SessionReplayDetail = {
  path: "/tmp/search.jsonl", sessionId: "search", threadName: null, modifiedAtMs: 0, sizeBytes: 0, rawJsonl: "", agents: [], turns: [],
  summary: {
    startTime: null, endTime: null, durationMs: null, timeToFirstTokenMs: null, cwd: null, projects: [], models: [], cliVersion: null, git: {},
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, costUSD: 0,
    turnCount: 0, messageCount: 0, toolCallCount: 0, patchCount: 0, errorCount: 0,
  },
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.useFakeTimers();
  SearchWorker.instances = [];
  vi.stubGlobal("Worker", SearchWorker);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("rejects late results after changing or clearing the query and releases the worker", async () => {
  const onChange = vi.fn();
  render(<SessionSearchToolbar detail={detail} scope="timeline" onChange={onChange} onClose={vi.fn()} ref={createRef<SessionSearchHandle>()} />);
  expect(SearchWorker.instances).toHaveLength(0);
  const input = screen.getByRole("searchbox");
  fireEvent.change(input, { target: { value: "old" } });
  await act(() => vi.advanceTimersByTimeAsync(150));
  const worker = SearchWorker.instances[0];
  const old = worker.latestRequest();
  fireEvent.change(input, { target: { value: "new" } });
  act(() => worker.reply("requestId" in old ? old.requestId : -1));
  expect(screen.getByRole("status")).toHaveTextContent("Searching");
  await act(() => vi.advanceTimersByTimeAsync(150));
  const latest = worker.latestRequest();
  act(() => worker.reply("requestId" in latest ? latest.requestId : -1));
  expect(screen.getByRole("status")).toHaveTextContent("1 / 3");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input).toHaveValue("");
  expect(onChange.mock.lastCall?.[0].active).toBe(false);
  expect(worker.terminate).toHaveBeenCalledOnce();
  act(() => worker.reply("requestId" in latest ? latest.requestId : -1, 2));
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
});

it("keeps rapid keyboard navigation ordered and reports worker failures", async () => {
  const onChange = vi.fn();
  render(<SessionSearchToolbar detail={detail} scope="timeline" onChange={onChange} onClose={vi.fn()} ref={createRef<SessionSearchHandle>()} />);
  const input = screen.getByRole("searchbox");
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: "needle" } });
  await act(() => vi.advanceTimersByTimeAsync(150));
  const worker = SearchWorker.instances[0];
  const request = worker.latestRequest();
  act(() => worker.reply("requestId" in request ? request.requestId : -1));
  fireEvent.keyDown(input, { key: "Enter" });
  const first = worker.latestRequest();
  fireEvent.keyDown(input, { key: "Enter" });
  const second = worker.latestRequest();
  expect(second).toMatchObject({ type: "select", index: 2 });
  act(() => worker.reply("requestId" in first ? first.requestId : -1, 1));
  expect(screen.getByRole("status")).toHaveTextContent("1 / 3");
  act(() => worker.reply("requestId" in second ? second.requestId : -1, 2));
  expect(screen.getByRole("status")).toHaveTextContent("3 / 3");
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(worker.latestRequest()).toMatchObject({ type: "select", index: 1 });
  act(() => worker.onerror?.());
  expect(screen.getByRole("status")).toHaveTextContent("Search unavailable");
  expect(onChange.mock.lastCall?.[0]).toMatchObject({ pending: false, error: true, hit: null });
});

it("highlights the original field, allows full text expansion, and restores its normal rendering", async () => {
  const text = `${"before\n".repeat(6000)}Needle${"\nafter".repeat(6000)}`;
  const turns: SessionReplayDetail["turns"] = [{
    turnId: "long", startedAt: null, completedAt: null, durationMs: null, systemMessages: [], userMessages: [], assistantMessages: [],
    reasoningSummaries: [], toolCalls: [], patchResults: [], tokenEvents: [], errors: [],
    items: [{ kind: "message", role: "user", text, timestamp: null, source: "message" }],
  }];
  const index = new SessionSearchIndex(buildSearchDocuments(turns), "");
  const hit = (await index.search("needle", "timeline", async () => {}))!.hit;
  const view = (active: typeof hit, full = false) => <SessionSearchContext value={active ? [active] : []}><SessionSearchText text={text} full={full}><p>Normal preview</p></SessionSearchText></SessionSearchContext>;
  const { rerender } = render(view(hit));
  expect(screen.getByTestId("session-search-current")).toHaveTextContent("Needle");
  expect(screen.getByTestId("session-search-window").textContent!.length).toBeLessThan(8500);
  rerender(view(hit, true));
  expect(screen.getByTestId("session-search-window").textContent).toBe(text);
  rerender(view(hit));
  fireEvent.click(screen.getByRole("button", { name: "Show full text" }));
  expect(screen.getByTestId("session-search-window").textContent).toBe(text);
  rerender(view(null));
  expect(screen.getByText("Normal preview")).toBeInTheDocument();
  expect(screen.queryByTestId("session-search-current")).not.toBeInTheDocument();
});

it("shows every distant occurrence together and moves the current highlight without hiding other matches", async () => {
  const text = `İ😀 [a.*] ${"x".repeat(40_000)} [A.*] ${"y".repeat(40_000)} [a.*]`;
  const index = new SessionSearchIndex([], text);
  await index.search("[a.*]", "raw", async () => {});
  const view = (selected: number) => <SessionSearchContext value={index.select(selected).matches}><SessionSearchText text={text} /></SessionSearchContext>;
  const { rerender } = render(view(1));
  expect(screen.getByTestId("session-search-current")).toHaveTextContent("[A.*]");
  expect(screen.getAllByTestId("session-search-match").map((mark) => mark.textContent)).toEqual(["[a.*]", "[a.*]"]);
  expect(screen.getByTestId("session-search-window").textContent!.length).toBeLessThan(25_000);
  rerender(view(2));
  expect(screen.getByTestId("session-search-current")).toHaveTextContent("[a.*]");
  expect(screen.getAllByTestId("session-search-match").map((mark) => mark.textContent)).toEqual(["[a.*]", "[A.*]"]);
});

it("offers a close button even when the query is empty", () => {
  const onClose = vi.fn();
  render(<SessionSearchToolbar detail={detail} scope="timeline" onChange={vi.fn()} onClose={onClose} ref={createRef<SessionSearchHandle>()} />);
  fireEvent.click(screen.getByRole("button", { name: "Close search" }));
  expect(onClose).toHaveBeenCalledOnce();
});
