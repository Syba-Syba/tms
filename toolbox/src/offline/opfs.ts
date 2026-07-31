/** Origin Private File System helpers for storing generated files without hitting quota errors. */
async function root() {
  return navigator.storage.getDirectory();
}

export async function writeFile(name: string, data: Blob | ArrayBuffer) {
  const dir = await root();
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
  return name;
}

export async function readFile(name: string) {
  const dir = await root();
  const handle = await dir.getFileHandle(name);
  return handle.getFile();
}

export async function deleteFile(name: string) {
  const dir = await root();
  await dir.removeEntry(name).catch(() => undefined);
}

export async function listFiles() {
  const dir = await root();
  const names: string[] = [];
  for await (const [name] of (dir as unknown as AsyncIterable<[string, unknown]>)) names.push(name);
  return names;
}

/** Deletes files older than the retention window, matching the seven day archive rule. */
export async function pruneOlderThan(days: number) {
  const cutoff = Date.now() - days * 86400000;
  for (const name of await listFiles()) {
    const file = await readFile(name).catch(() => null);
    if (file && file.lastModified < cutoff) await deleteFile(name);
  }
}
