const DATABASE_NAME = "visa-helper-workspace-session-v1";
const DATABASE_VERSION = 1;
const STORE_NAME = "session";
const TOKEN_KEY = "visa-helper.workspace-session-token";

function sessionToken(create = false) {
  let token = sessionStorage.getItem(TOKEN_KEY);
  if (!token && create) {
    token = crypto.randomUUID();
    sessionStorage.setItem(TOKEN_KEY, token);
  }
  return token;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function putRecord(key, value) {
  const token = sessionToken(true);
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ key, token, value });
      transaction.addEventListener("complete", resolve);
      transaction.addEventListener("error", () => reject(transaction.error));
      transaction.addEventListener("abort", () => reject(transaction.error));
    });
  } finally {
    database.close();
  }
}

async function getRecord(key, token) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
      request.addEventListener("success", () => {
        const record = request.result;
        resolve(record?.token === token ? record.value : null);
      });
      request.addEventListener("error", () => reject(request.error));
    });
  } finally {
    database.close();
  }
}

function restoreRelativePath(file, relativePath) {
  if (!relativePath || file.webkitRelativePath === relativePath) return file;
  try {
    Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  } catch {
    // File remains usable even if a browser does not allow restoring this display-only property.
  }
  return file;
}

export async function saveWorkspaceFiles(files) {
  const records = Array.from(files || []).map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }));
  await putRecord("files", records);
}

export async function saveWorkspaceState(state) {
  await putRecord("state", state);
}

export async function restoreWorkspaceSession() {
  const token = sessionToken(false);
  if (!token) {
    await clearWorkspaceSession();
    return null;
  }
  const [state, records] = await Promise.all([
    getRecord("state", token),
    getRecord("files", token),
  ]);
  if (!state) return null;
  return {
    state,
    files: (records || []).map(({ file, relativePath }) => restoreRelativePath(file, relativePath)),
  };
}

export async function clearWorkspaceSession() {
  sessionStorage.removeItem(TOKEN_KEY);
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.addEventListener("success", resolve);
    request.addEventListener("blocked", resolve);
    request.addEventListener("error", () => reject(request.error));
  });
}
