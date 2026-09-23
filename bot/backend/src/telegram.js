export class TelegramBotApi {
  constructor(token) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async call(method, payload = {}) {
    const response = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await response.json();
    if (!body.ok) throw new Error(`Telegram ${method}: ${body.description || response.status}`);
    return body.result;
  }

  getMe() { return this.call('getMe'); }
  getUpdates(payload) { return this.call('getUpdates', payload); }
  sendMessage(chatId, text, extra = {}) { return this.call('sendMessage', { chat_id: chatId, text, ...extra }); }
  editMessageText(chatId, messageId, text, extra = {}) { return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra }); }
  answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text, show_alert: showAlert });
  }
  copyMessage(chatId, fromChatId, messageId, extra = {}) { return this.call('copyMessage', { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId, ...extra }); }
  deleteMessage(chatId, messageId) { return this.call('deleteMessage', { chat_id: chatId, message_id: messageId }); }

  async sendPhoto(chatId, buffer, filename = 'ticket.png', caption = '', extra = {}) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('photo', new Blob([buffer], { type: 'image/png' }), filename);
    if (caption) form.append('caption', caption);
    for (const [key, value] of Object.entries(extra)) {
      if (value == null) continue;
      form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    const response = await fetch(`${this.base}/sendPhoto`, { method: 'POST', body: form });
    const body = await response.json();
    if (!body.ok) throw new Error(`Telegram sendPhoto: ${body.description || response.status}`);
    return body.result;
  }

  async sendDocument(chatId, buffer, filename, caption = '', extra = {}) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', new Blob([buffer], { type: 'text/csv' }), filename);
    if (caption) form.append('caption', caption);
    for (const [key, value] of Object.entries(extra)) {
      if (value == null) continue;
      form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    const response = await fetch(`${this.base}/sendDocument`, { method: 'POST', body: form });
    const body = await response.json();
    if (!body.ok) throw new Error(`Telegram sendDocument: ${body.description || response.status}`);
    return body.result;
  }
}

export function inlineKeyboard(rows) {
  return { inline_keyboard: rows };
}

export function replyKeyboard(rows, { resize = true, oneTime = false, placeholder = '' } = {}) {
  return {
    keyboard: rows,
    resize_keyboard: resize,
    one_time_keyboard: oneTime,
    input_field_placeholder: placeholder || undefined
  };
}

export function removeKeyboard() { return { remove_keyboard: true }; }
