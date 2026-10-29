// A receipt image is operational evidence. Deliver it to every configured
// administrator immediately after accepting proof, regardless of whether the
// transaction can be verified automatically.
export function receiptAdminCaption(purchase) {
  const numbers = (purchase.numbers || []).map(
    ({ pool, number }) => pool + ' ETB #' + String(number).padStart(3, '0')
  ).join(' · ');
  return [
    '🧾 PAYMENT RECEIPT · Verification pending',
    'Purchase: ' + purchase.id,
    'Buyer: ' + purchase.buyer_name,
    'Phone: ' + purchase.buyer_phone,
    'Amount expected: ' + purchase.amount_etb + ' ETB',
    'Numbers: ' + numbers,
    'Destination: ' + (purchase.payment_provider || 'Unknown') + ' · ' + (purchase.payment_account_number || 'Unknown'),
    'Reference: ' + String(purchase.payment_reference || 'No link/reference').slice(0, 220),
    '⚠️ Screenshot alone does not prove payment. Verify bank receipt before approval.'
  ].join('\n').slice(0, 1024);
}

export async function deliverReceiptToAdmins({ bot, adminIds, purchase, message, logger = console }) {
  const photo = message?.photo?.at(-1)?.file_id;
  const document = message?.document?.file_id;
  const fileId = photo || document;
  if (!fileId) return { attempted: 0, delivered: 0, failed: [] };

  const admins = [...new Set((adminIds || []).filter((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0))];
  const failed = [];
  if (!admins.length) {
    logger.error('[payment-receipt] No admin recipients configured for purchase', purchase.id);
    return { attempted: 0, delivered: 0, failed: [] };
  }

  const caption = receiptAdminCaption(purchase);
  let delivered = 0;
  await Promise.all(admins.map(async (adminId) => {
    try {
      await bot.copyMessage(adminId, message.chat.id, message.message_id, { caption });
      delivered++;
    } catch (copyError) {
      // Telegram may reject copyMessage for some uploaded media. Reuse the
      // Telegram file_id as a fallback without downloading or storing the image.
      try {
        await bot.call(photo ? 'sendPhoto' : 'sendDocument', {
          chat_id: adminId,
          [photo ? 'photo' : 'document']: fileId,
          caption
        });
        delivered++;
      } catch (sendError) {
        failed.push(adminId);
        logger.error('[payment-receipt] Could not deliver to admin', adminId,
          'purchase', purchase.id, 'copy:', copyError?.message, 'fallback:', sendError?.message);
      }
    }
  }));

  return { attempted: admins.length, delivered, failed };
}
