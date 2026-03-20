// ============================================
// Blue Sky Cattery - Email Worker
// Handles photos@blueskycattery.com
// No forwarding - just parse photos and POST to webhook
// ============================================

export default {
  async email(message, env, ctx) {
    try {
    const from = message.from;
    const subject = message.headers.get('subject') || '';

    // Read raw email stream using ReadableStream reader
    let rawText = '';
    try {
      const reader = message.raw.getReader();
      const chunks = [];
      let totalSize = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalSize += value.length;
        if (totalSize > 20 * 1024 * 1024) break; // 20MB safety limit
      }
      const allBytes = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of chunks) {
        allBytes.set(chunk, offset);
        offset += chunk.length;
      }
      rawText = new TextDecoder('utf-8', { fatal: false }).decode(allBytes);
    } catch(e) {
      // Last resort: try Response approach
      try {
        const resp = new Response(message.raw);
        rawText = await resp.text();
      } catch(e2) {
        return;
      }
    }

    // Parse MIME for text and image attachments
    const textBody = extractPlainText(rawText);
    const attachments = extractImageAttachments(rawText);

    // POST to portal webhook
    const payload = {
      items: [{
        From: { Address: from },
        Subject: subject,
        RawTextBody: textBody,
        Attachments: attachments
      }]
    };

    await fetch('https://portal.blueskycattery.com/api/webhook/inbound-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    } catch(topError) {
      // Emergency: if everything fails, at least log it via webhook
      await fetch('https://portal.blueskycattery.com/api/webhook/inbound-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ From: { Address: message.from || 'unknown' }, Subject: 'EMAIL WORKER ERROR: ' + (topError.message || topError), RawTextBody: 'The email worker crashed processing this email.', Attachments: [] }] })
      }).catch(() => {});
    }
  }
};

function extractPlainText(raw) {
  const boundary = findBoundary(raw);
  if (!boundary) {
    const idx = raw.indexOf('\r\n\r\n');
    return idx > -1 ? raw.slice(idx + 4, idx + 5004).trim() : '';
  }
  for (const part of raw.split('--' + boundary)) {
    if (part.match(/Content-Type:\s*text\/plain/i)) {
      const idx = part.indexOf('\r\n\r\n');
      if (idx === -1) continue;
      let body = part.slice(idx + 4).trim();
      if (part.match(/Content-Transfer-Encoding:\s*base64/i)) {
        try { body = atob(body.replace(/\s/g, '')); } catch(e) {}
      }
      if (part.match(/Content-Transfer-Encoding:\s*quoted-printable/i)) {
        body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      }
      return body.slice(0, 5000);
    }
  }
  return '';
}

function extractImageAttachments(raw) {
  const attachments = [];
  // Find all multipart boundaries (including nested)
  const boundaries = [];
  for (const m of raw.matchAll(/Content-Type:\s*multipart\/[^;]+;\s*boundary=["']?([^"'\r\n;]+)/gi)) {
    boundaries.push(m[1].trim());
  }
  if (boundaries.length === 0) return attachments;

  for (const b of boundaries) {
    for (const part of raw.split('--' + b)) {
      const ctMatch = part.match(/Content-Type:\s*(image\/[^\s;\r\n]+)/i);
      if (!ctMatch) continue;
      if (!part.match(/Content-Transfer-Encoding:\s*base64/i)) continue;
      const nameMatch = part.match(/(?:file)?name=["']?([^"'\r\n;]+)/i);
      const filename = nameMatch ? nameMatch[1].trim() : 'photo.jpg';
      const idx = part.indexOf('\r\n\r\n');
      if (idx === -1) continue;
      let base64 = part.slice(idx + 4).trim();
      const bIdx = base64.indexOf('--');
      if (bIdx > 0) base64 = base64.slice(0, bIdx);
      base64 = base64.replace(/[\r\n\s]/g, '');
      if (base64.length > 1000) {
        attachments.push({ Name: filename, ContentType: ctMatch[1], Content: base64 });
      }
    }
  }
  return attachments;
}

function findBoundary(raw) {
  const m = raw.match(/Content-Type:\s*multipart\/[^;]+;\s*boundary=["']?([^"'\r\n;]+)/i);
  return m ? m[1].trim() : null;
}
