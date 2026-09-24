import { Jimp } from 'jimp';
import jsQR from 'jsqr';

export class TelegramBotApi {
  constructor(token) {
    this.token = token;
    this.base = `https://api.telegram.org/bot${token}`;
    this.fileBase = `https://api.telegram.org/file/bot${token}`;
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
  async getUpdates(payload) {
    const updates = await this.call('getUpdates', payload);
    await Promise.all(updates.map(async (update) => {
      try { await this.enrichQrFromUpload(update); } catch {}

      // Telegram creates a visible service message when a reply-keyboard Mini App
      // calls WebApp.sendData(): “Data from the ... button was transferred to the bot.”
      // Remove that transport-only message immediately while keeping the web_app_data
      // on the in-memory update so the normal purchase flow still processes it.
      const message = update?.message;
      if (message?.web_app_data && message?.chat?.id && message?.message_id) {
        try { await this.deleteMessage(message.chat.id, message.message_id); } catch {}
      }
    }));
    return updates;
  }
  sendMessage(chatId, text, extra = {}) { return this.call('sendMessage', { chat_id: chatId, text, ...extra }); }
  editMessageText(chatId, messageId, text, extra = {}) { return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra }); }
  answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text, show_alert: showAlert });
  }
  copyMessage(chatId, fromChatId, messageId, extra = {}) { return this.call('copyMessage', { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId, ...extra }); }
  deleteMessage(chatId, messageId) { return this.call('deleteMessage', { chat_id: chatId, message_id: messageId }); }

  async enrichQrFromUpload(update) {
    const message = update?.message;
    if (!message || message.text || message.caption) return;

    const photoFileId = message.photo?.at(-1)?.file_id || null;
    const document = message.document || null;
    const documentName = String(document?.file_name || '').toLowerCase();
    const documentMime = String(document?.mime_type || '').toLowerCase();
    const imageDocument = Boolean(document?.file_id) && (
      documentMime.startsWith('image/') || /\.(?:png|jpe?g|bmp)$/i.test(documentName)
    );
    const fileId = photoFileId || (imageDocument ? document.file_id : null);
    if (!fileId) return;

    const qrData = await this.readQrFromTelegramFile(fileId);
    if (!qrData) return;

    // Payment proof handling already treats captions as a transaction
    // link/reference. Injecting the decoded QR keeps the existing Verify.et and
    // manual-review flow unchanged.
    message.caption = qrData.slice(0, 300);
  }

  async readQrFromTelegramFile(fileId) {
    const file = await this.call('getFile', { file_id: fileId });
    if (!file?.file_path || Number(file.file_size || 0) > 12 * 1024 * 1024) return null;

    const response = await fetch(`${this.fileBase}/${file.file_path}`);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const image = await Jimp.read(buffer);
    let scan = image;

    // Keep ordinary screenshots at full resolution for QR accuracy. Only reduce
    // unusually large images so one upload cannot consume excessive CPU/memory.
    const pixels = image.bitmap.width * image.bitmap.height;
    if (pixels > 5_000_000) {
      const factor = Math.sqrt(5_000_000 / pixels);
      scan = image.clone().scale(factor);
    }

    const rgba = new Uint8ClampedArray(scan.bitmap.data);
    const result = jsQR(rgba, scan.bitmap.width, scan.bitmap.height, { inversionAttempts: 'attemptBoth' });
    const value = String(result?.data || '').trim();
    return value || null;
  }

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
  const normalizedRows = Array.isArray(rows) ? rows.map((row) => Array.isArray(row) ? [...row] : row) : rows;

  // Payment-proof reviews must always let an administrator make a decision from
  // the very first screenshot. Older review layouts only exposed Ask link +
  // Reject until a reference existed, which unnecessarily blocked manual approval.
  if (Array.isArray(normalizedRows)) {
    const buttons = normalizedRows.flatMap((row) => Array.isArray(row) ? row : []);
    const askReference = buttons.find((button) => String(button?.callback_data || '').startsWith('admin_pay_askref:'));
    const hasManualApprove = buttons.some((button) => String(button?.callback_data || '').startsWith('admin_pay_ok:'));
    const hasReject = buttons.some((button) => String(button?.callback_data || '').startsWith('admin_pay_no:'));

    if (askReference && hasReject && !hasManualApprove) {
      const purchaseId = String(askReference.callback_data).split(':')[1] || '';
      if (purchaseId) {
        normalizedRows.unshift([
          { text: '✅ Approve manually', callback_data: `admin_pay_ok:${purchaseId}` }
        ]);
      }
    }
  }

  return { inline_keyboard: normalizedRows };
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
