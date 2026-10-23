import { buildSearchDocuments, SessionSearchIndex, type SessionSearchRequest, type SessionSearchResponse } from "./session-search";

let index: SessionSearchIndex;

self.onmessage = async ({ data }: MessageEvent<SessionSearchRequest>) => {
  if (data.type === "init") {
    index = new SessionSearchIndex(buildSearchDocuments(data.turns), data.rawJsonl);
    return;
  }
  if (data.type === "cancel") {
    index.cancel();
    return;
  }
  const result = data.type === "search"
    ? await index.search(data.query, data.scope, () => new Promise((resolve) => setTimeout(resolve, 0)))
    : index.select(data.index);
  if (result) self.postMessage({ ...result, requestId: data.requestId } satisfies SessionSearchResponse);
};
