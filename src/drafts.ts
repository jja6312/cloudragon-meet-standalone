import type { Draft } from "./model";

type PendingChunk = {
  key: string;
  draftKey: string;
  sequence: number;
  blob: Blob;
};
let opened: Promise<IDBDatabase> | undefined;
function database() {
  return (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("cloudragon-meet-standalone-recovery-v1", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("drafts", { keyPath: "key" });
      request.result
        .createObjectStore("chunks", { keyPath: "key" })
        .createIndex("draftKey", "draftKey");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opened = undefined;
      reject(
        new Error(
          "기기 임시 저장소를 열지 못했습니다. 브라우저 저장 공간을 확인하세요.",
        ),
      );
    };
  }));
}
async function write(stores: string[], action: (tx: IDBTransaction) => void) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(
        new Error(
          "기기 저장 공간이 부족하거나 임시 저장이 중단됐습니다. 녹음을 마무리해 주세요.",
        ),
      );
    action(tx);
  });
}
async function read<T>(
  store: string,
  query: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const request = query(tx.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("기기 임시본을 읽지 못했습니다."));
  });
}
export const draftKey = (subject: string, workspace: string, id: string) =>
  `${subject}/${workspace}/${id}`;
export async function saveDraft(draft: Draft) {
  await write(["drafts"], (tx) => tx.objectStore("drafts").put(draft));
}
export async function saveChunk(draft: Draft, sequence: number, blob: Blob) {
  // Chunk and nextSequence commit together: a reload can never finalize before the last durable chunk.
  await write(["drafts", "chunks"], (tx) => {
    tx.objectStore("drafts").put(draft);
    tx.objectStore("chunks").put({
      key: `${draft.key}/${sequence}`,
      draftKey: draft.key,
      sequence,
      blob,
    });
  });
}
export async function listDrafts(subject: string, workspace: string) {
  return (await read<Draft[]>("drafts", (store) => store.getAll())).filter(
    (d) => d.subject === subject && d.workspace === workspace,
  );
}
export async function pendingChunks(key: string) {
  return (
    await read<PendingChunk[]>("chunks", (store) =>
      store.index("draftKey").getAll(key),
    )
  ).sort((a, b) => a.sequence - b.sequence);
}
export async function removeChunk(key: string) {
  await write(["chunks"], (tx) => tx.objectStore("chunks").delete(key));
}
export async function removeDraft(key: string) {
  const chunks = await pendingChunks(key);
  await write(["drafts", "chunks"], (tx) => {
    tx.objectStore("drafts").delete(key);
    chunks.forEach((chunk) => tx.objectStore("chunks").delete(chunk.key));
  });
}
