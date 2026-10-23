import type { SessionReplayDetail } from "./api";
import {
  buildSessionConversation, cleanExecOutput, formatJsonForDisplay, formatToolArgumentValue,
  parseUserInputAnswers, type ExecOutput, type TimelineEntry,
} from "./session-conversation";

export type SearchScope = "timeline" | "raw";
type SearchDocument = {
  turnIndex: number;
  blockIndex: number;
  entryIndex: number;
  field: string;
  context: string;
  target?: string;
  text: string;
};

export type SessionSearchHit = Omit<SearchDocument, "text"> & {
  offset: number;
  windowStart: number;
  text: string;
  highlightStart: number;
  highlightEnd: number;
  length: number;
  offsets: number[];
  current: boolean;
};
export type SessionSearchResult = { count: number; index: number; hit: SessionSearchHit | null; matches: SessionSearchHit[] };
export type SessionSearchRequest =
  | { type: "init"; turns: SessionReplayDetail["turns"]; rawJsonl: string }
  | { type: "cancel" }
  | { type: "search"; requestId: number; query: string; scope: SearchScope }
  | { type: "select"; requestId: number; index: number };
export type SessionSearchResponse = SessionSearchResult & { requestId: number };

export function buildSearchDocuments(turns: SessionReplayDetail["turns"]) {
  const documents: SearchDocument[] = [];
  buildSessionConversation(turns).forEach((blocks, turnIndex) => blocks.forEach((block, blockIndex) => {
    const entries = block.kind === "item" ? [block.entry] : block.entries;
    entries.forEach(({ item, activity }: TimelineEntry, entryIndex) => {
      const context = item.kind === "toolCall" ? activity!.displayToolName : "";
      let target: string | undefined;
      const add = (field: string, text: string | null | undefined, label = context) => {
        if (text) documents.push({ turnIndex, blockIndex, entryIndex, field, context: label, target, text });
      };
      const output = (value: ExecOutput | null, label = context) => {
        add("output", value?.stdout ? cleanExecOutput(value.stdout) : null, label);
        add("stderr", value?.stderr, label);
      };
      if (item.kind === "message") add(item.role, item.text);
      else if (item.kind === "reasoning") add("reasoning_summary", item.text);
      else if (item.kind === "error") add("error", item.text);
      else if (item.kind === "notice") add("output", [item.label, item.text].filter(Boolean).join(" · "));
      else if (item.kind === "patch") {
        if (item.isError || item.success === false) add("patch_output", item.output);
      } else if (activity) {
        add("sleep_tool", activity.displayToolName);
        if (activity.userInputQuestions) {
          const answers = parseUserInputAnswers(item.kind === "toolCall" ? item.output : null);
          for (const question of activity.userInputQuestions) {
            add("user_input_request", question.header);
            add("user_input_request", question.question);
            for (const option of question.options) {
              add("arguments", option.label);
              add("arguments", option.description);
            }
            for (const answer of answers[question.id] ?? []) add("output", answer);
          }
          return;
        }
        if (activity.webSearchQueries || activity.webOpenReferences || activity.webSearchResults) {
          for (const query of activity.webSearchQueries ?? activity.webOpenReferences ?? []) add("arguments", query);
          if (activity.webSearchResults) {
            for (const result of activity.webSearchResults) {
              add("search_result", result.title);
              add("search_result", result.url);
              add("search_result", result.snippet);
            }
          } else add("output", activity.outputText ? cleanExecOutput(activity.outputText) : null);
          return;
        }
        if (activity.backgroundTerminalInput !== null) {
          add("command", activity.backgroundTerminalInput);
          const response = [
            ...(activity.unpairedOutputs.length ? activity.unpairedOutputs.flatMap((value) => [value.stdout, value.stderr]) : [activity.contentBlocks?.texts.join("\n") ?? activity.outputText]),
            activity.unpairedOutputs.length ? activity.unparsedOutputText : null, activity.stderrText,
          ].filter(Boolean).join("\n");
          add("output", cleanExecOutput(response));
          return;
        }
        if (activity.nestedActivities) add("arguments", activity.retainedArguments);
        else {
          add(activity.execArguments ? "command" : "arguments", activity.argumentsText);
          add("working_directory", activity.execArguments?.workdir);
          for (const [key, value] of activity.argumentEntries) {
            add("arguments", formatToolArgumentValue(value), `${context} · ${key}`);
          }
        }
        // Use the projected text, so encoded outputs and nested command records are searched once.
        for (const [nestedIndex, nested] of (activity.nestedActivities ?? []).entries()) {
          target = `nested-${nestedIndex}`;
          if (nested.kind === "command") {
            add("sleep_tool", "exec_command", nested.command.slice(0, 160));
            add("command", nested.command, "exec_command");
            add("working_directory", nested.workdir, "exec_command");
            output(nested.output, nested.command.slice(0, 160));
          } else if (nested.kind === "terminal") {
            add("sleep_tool", "write_stdin");
            add("command", nested.input, "write_stdin");
            add("output", cleanExecOutput([nested.output?.stdout, nested.output?.stderr].filter(Boolean).join("\n")), "write_stdin");
          } else if (nested.kind === "patch") {
            add("sleep_tool", "apply_patch");
            add("patch_input", nested.patch, "apply_patch");
          } else if (nested.kind === "image") {
            add("sleep_tool", "view_image");
            add("file_path", nested.path, "view_image");
          } else {
            add("sleep_tool", "web__run");
            for (const query of nested.kind === "webSearch" ? nested.queries : nested.references) add("arguments", query, "web");
            add("output", nested.output ? cleanExecOutput(nested.output) : null, "web");
          }
        }
        for (const [outputIndex, value] of activity.unpairedOutputs.entries()) {
          target = `output-${outputIndex}`;
          output(value);
        }
        target = undefined;
        const text = activity.nestedActivities ? activity.unparsedOutputText : activity.outputText;
        add("output", text ? formatJsonForDisplay(cleanExecOutput(text)) : null);
        add("stderr", activity.stderrText);
      }
    });
  }));
  return documents;
}

const CONTEXT_LENGTH = 4000;
const MAX_VISIBLE_MATCHES = 200;

export class SessionSearchIndex {
  private groups: { document: SearchDocument; offsets: number[]; first: number }[] = [];
  private count = 0;
  private queryLength = 0;
  private generation = 0;

  constructor(private documents: SearchDocument[], private rawJsonl: string) {}

  cancel() {
    this.generation += 1;
  }

  async search(query: string, scope: SearchScope, yieldTask: () => Promise<void>): Promise<SessionSearchResult | null> {
    const generation = ++this.generation;
    this.groups = [];
    this.count = 0;
    this.queryLength = query.length;
    if (!query) return this.select(0);
    // RegExp's Unicode case folding preserves offsets in the original string (lowercasing may not).
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    const documents = scope === "raw"
      ? [{ turnIndex: -1, blockIndex: -1, entryIndex: -1, field: "raw_jsonl", context: "", text: this.rawJsonl }]
      : this.documents;
    let lastYield = performance.now();
    for (const document of documents) {
      const offsets: number[] = [];
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(document.text)) !== null) {
        offsets.push(match.index);
        if (performance.now() - lastYield > 8) {
          await yieldTask();
          if (generation !== this.generation) return null;
          lastYield = performance.now();
        }
      }
      if (offsets.length) {
        this.groups.push({ document, offsets, first: this.count });
        this.count += offsets.length;
      }
      if (performance.now() - lastYield > 8) {
        await yieldTask();
        if (generation !== this.generation) return null;
        lastYield = performance.now();
      }
    }
    return this.select(0);
  }

  select(index: number): SessionSearchResult {
    if (!this.count) return { count: 0, index: 0, hit: null, matches: [] };
    index = ((index % this.count) + this.count) % this.count;
    let low = 0;
    let high = this.groups.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.groups[middle].first <= index) low = middle;
      else high = middle - 1;
    }
    const group = this.groups[low];
    // Keep all offsets in the worker for counting/navigation, but bound the WebView's DOM work.
    const limited = this.count > MAX_VISIBLE_MATCHES;
    const matches = (limited ? [group] : this.groups).map((matchGroup) => {
      const current = matchGroup === group;
      const selected = current ? index - matchGroup.first : 0;
      const offset = matchGroup.offsets[selected];
      const start = Math.max(0, selected - Math.floor(MAX_VISIBLE_MATCHES / 2));
      const offsets = limited ? matchGroup.offsets.slice(start, start + MAX_VISIBLE_MATCHES) : matchGroup.offsets;
      const { text, ...position } = matchGroup.document;
      const windowStart = Math.max(0, offset - CONTEXT_LENGTH);
      const end = Math.min(text.length, offset + this.queryLength + CONTEXT_LENGTH);
      return {
        ...position, offset, windowStart, text: text.slice(windowStart, end),
        highlightStart: offset - windowStart, highlightEnd: offset - windowStart + this.queryLength,
        length: text.length, offsets, current,
      };
    });
    return { count: this.count, index, hit: matches[limited ? 0 : low], matches };
  }
}
