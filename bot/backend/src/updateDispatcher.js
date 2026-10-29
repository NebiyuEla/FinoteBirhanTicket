// Process independent Telegram chats in parallel while preserving order within
// each chat. This prevents a slow receipt/Verify.et request from freezing the
// ticket and menu flows for other users.
export async function processUpdateBatch(updates, handle, onError, maxConcurrent = 8) {
  const groups = new Map();
  for (const update of updates) {
    const chat = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id
      ?? update.callback_query?.from?.id ?? update.update_id;
    const key = String(chat);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(update);
  }

  const tasks = [...groups.values()];
  let next = 0;
  const workerCount = Math.min(Math.max(1, Math.floor(maxConcurrent)), tasks.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < tasks.length) {
      const group = tasks[next++];
      for (const update of group) {
        const started = Date.now();
        try {
          await handle(update);
        } catch (error) {
          try { await onError(update, error); }
          catch (reportError) { console.error('[update-error-report]', reportError); }
        } finally {
          const elapsedMs = Date.now() - started;
          if (elapsedMs >= 2500) {
            console.warn('[slow-update]', {
              updateId: update.update_id,
              chatId: update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? null,
              elapsedMs
            });
          }
        }
      }
    }
  }));
}
