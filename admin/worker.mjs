import { PDFDocument, StandardFonts, PDFName, PDFString, rgb } from 'pdf-lib';

const portal = 'https://ldrpzl3672.github.io/ldr-payment-portal/';
const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return Response.json(data, { status, headers });
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const validEmail = value => typeof value === 'string' && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
const unpaid = invoice => Number(invoice.balance) > 0 &&
  ['sent', 'overdue', 'unpaid', 'partially_paid', 'viewed'].includes(invoice.status);

let oauth;
async function token(env) {
  if (!oauth || oauth.env !== env || oauth.expires < Date.now()) {
    const entry = { env, expires: Infinity };
    oauth = entry;
    entry.promise = (async () => {
      try {
        const response = await fetch('https://accounts.zoho.com/oauth/v2/token', {
          method: 'POST', redirect: 'error',
          body: new URLSearchParams({
            grant_type: 'refresh_token', client_id: env.ZOHO_CLIENT_ID,
            client_secret: env.ZOHO_CLIENT_SECRET, refresh_token: env.ZOHO_REFRESH_TOKEN,
          }),
        });
        const data = await response.json();
        if (!response.ok || !data.access_token) throw new Error('OAuth failure');
        entry.expires = Date.now() + Math.max(0, Number(data.expires_in || 3600) - 120) * 1000;
        return data.access_token;
      } catch {
        if (oauth === entry) oauth = undefined;
        throw new RequestError(502, 'Zoho authorization failed. Check the admin Worker credentials.');
      }
    })();
  }
  return oauth.promise;
}

async function zoho(env, path, query = {}, options = {}) {
  const url = new URL('https://www.zohoapis.com/books/v3/' + path);
  url.search = new URLSearchParams({ ...query, organization_id: env.ZOHO_ORGANIZATION_ID });
  const response = await fetch(url, {
    method: options.body ? 'POST' : 'GET',
    redirect: 'error',
    headers: {
      Authorization: 'Zoho-oauthtoken ' + await token(env),
      Accept: options.pdf ? 'application/pdf' : 'application/json',
      ...(options.body && { 'Content-Type': 'application/json' }),
    },
    body: options.body && JSON.stringify(options.body),
  });
  if (response.status === 404) throw new RequestError(404, 'Zoho record not found.');
  if (!response.ok) throw new RequestError(502, options.body
    ? 'Zoho did not confirm the email. Check Zoho before retrying.'
    : 'Zoho could not complete the request.');
  if (options.pdf) {
    if (!/^application\/pdf\b/i.test(response.headers.get('Content-Type') || '')) {
      throw new RequestError(502, 'Zoho did not return an invoice PDF.');
    }
    return response.arrayBuffer();
  }
  const result = await response.json();
  if (result.code !== 0) throw new RequestError(502, 'Zoho did not confirm the request.');
  return result;
}

async function verifiedInvoice(env, customerId, invoiceId) {
  const { invoice } = await zoho(env, 'invoices/' + invoiceId);
  if (invoice?.customer_id !== customerId || !unpaid(invoice)) {
    throw new RequestError(404, 'Unpaid invoice not found for this customer.');
  }
  const { contact } = await zoho(env, 'contacts/' + customerId);
  if (contact?.contact_type !== 'customer' || contact.contact_id !== customerId) {
    throw new RequestError(404, 'Customer not found.');
  }
  const field = contact.custom_fields?.find(item => item.label === 'Portal Token');
  const portalToken = String(field?.value ?? '').trim();
  if (!portalToken) throw new RequestError(409, 'This customer has no Portal Token in Zoho.');
  const query = new URLSearchParams({ token: portalToken });
  const response = await env.PAYMENT_API.fetch('https://ldr-payment-api.ldrpzl3672.workers.dev/api/invoices?' + query);
  if (!response.ok) throw new RequestError(502, 'The payment portal could not verify this invoice.');
  const data = await response.json();
  if (data.error || !data.invoices?.some(item => String(item.invoice_id) === invoiceId)) {
    throw new RequestError(409, 'This invoice is unavailable through the customer’s payment link.');
  }
  return { invoice, contact, link: portal + '?' + query };
}

async function linkedPdf(source, link) {
  const pdf = await PDFDocument.load(source, { updateMetadata: false });
  const page = pdf.addPage();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Lester Digital | Online payment', { x: 54, y: 730, size: 22, font });
  const label = 'Open the Lester Digital payment portal';
  page.drawText(label, { x: 54, y: 685, size: 14, font, color: rgb(0.05, 0.28, 0.55) });
  const annotation = pdf.context.register(pdf.context.obj({
    Type: 'Annot', Subtype: 'Link',
    Rect: [54, 680, 54 + font.widthOfTextAtSize(label, 14), 703],
    Border: [0, 0, 0],
    A: { S: 'URI', URI: PDFString.of(link) },
  }));
  page.node.set(PDFName.of('Annots'), pdf.context.obj([annotation]));
  return pdf.save();
}

function pageNumber(url) {
  const page = Number(url.searchParams.get('page') ?? '1');
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000) {
    throw new RequestError(400, 'Invalid page.');
  }
  return page;
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (!env.ACCESS_AUD || ctx.access?.aud !== env.ACCESS_AUD || !env.ADMIN_EMAIL ||
          (await ctx.access.getIdentity())?.email?.toLowerCase() !== env.ADMIN_EMAIL.trim().toLowerCase()) {
        return json({ error: 'Administrator access required.' }, 403);
      }
      const url = new URL(request.url);
      if (request.method === 'GET' && files[url.pathname] && Object.hasOwn(files, url.pathname)) {
        const [type, body] = files[url.pathname];
        return new Response(body, { headers: { ...headers, 'Content-Type': type } });
      }
      if (request.method === 'GET' && url.pathname === '/api/customers') {
        const q = url.searchParams.get('q')?.trim() || '';
        if (q.length < 2 || q.length > 100) throw new RequestError(400, 'Enter 2–100 characters.');
        const data = await zoho(env, 'contacts', {
          contact_type: 'customer', contact_name_contains: q, page: pageNumber(url), per_page: 25,
        });
        return json({
          customers: data.contacts.map(contact => ({
            id: contact.contact_id, name: contact.contact_name, company: contact.company_name,
          })),
          more: data.page_context?.has_more_page === true,
        });
      }
      const route = url.pathname.match(/^\/api\/customers\/(\d{1,30})\/invoices(?:\/(\d{1,30})\/(pdf|email))?$/);
      if (!route) return json({ error: 'Page not found.' }, 404);
      const [, customerId, invoiceId, action] = route;
      if (!invoiceId && request.method === 'GET') {
        const data = await zoho(env, 'invoices', {
          customer_id: customerId, page: pageNumber(url), per_page: 25,
        });
        return json({
          invoices: data.invoices.filter(item => item.customer_id === customerId && unpaid(item)).map(item => ({
            id: item.invoice_id, number: item.invoice_number, due: item.due_date,
            balance: item.balance, currency: item.currency_code,
          })),
          more: data.page_context?.has_more_page === true,
        });
      }
      if (action === 'pdf' && request.method === 'GET') {
        const { invoice, link } = await verifiedInvoice(env, customerId, invoiceId);
        const source = await zoho(env, 'invoices/' + invoiceId, {}, { pdf: true });
        const filename = String(invoice.invoice_number || invoiceId).replace(/[^a-zA-Z0-9_-]/g, '-');
        return new Response(await linkedPdf(source, link), {
          headers: { ...headers, 'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="Invoice-' + filename + '.pdf"' },
        });
      }
      if (action === 'email' && request.method === 'GET') {
        const { invoice, contact } = await verifiedInvoice(env, customerId, invoiceId);
        if (!validEmail(contact.email)) throw new RequestError(409, 'The customer has no valid email in Zoho.');
        return json({ to: contact.email, subject: 'Lester Digital invoice ' + invoice.invoice_number });
      }
      if (action === 'email' && request.method === 'POST') {
        if (request.headers.get('Origin') !== url.origin ||
            request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') {
          throw new RequestError(403, 'Submit email from the dashboard.');
        }
        const raw = await request.text();
        if (raw.length > 12000) throw new RequestError(413, 'Email message is too long.');
        let input;
        try { input = JSON.parse(raw); } catch { throw new RequestError(400, 'Invalid email request.'); }
        const { contact, link } = await verifiedInvoice(env, customerId, invoiceId);
        if (!validEmail(contact.email) || input?.to !== contact.email) {
          throw new RequestError(409, 'The customer’s email changed. Reopen the email preview.');
        }
        const { subject, message } = input;
        if (typeof subject !== 'string' || !subject.trim() || subject.length > 150 || /[\r\n]/.test(subject) ||
            typeof message !== 'string' || !message.trim() || message.length > 5000) {
          throw new RequestError(400, 'Enter a subject and message within the allowed lengths.');
        }
        await zoho(env, 'invoices/' + invoiceId + '/email', {}, { body: {
          send_from_org_email_id: true, to_mail_ids: [contact.email], subject: subject.trim(),
          body: escapeHtml(message.trim()).replace(/\r?\n/g, '<br>') +
            '<br><br><a href="' + escapeHtml(link) + '">Open the Lester Digital payment portal</a>',
        } });
        return json({ sent: true });
      }
      return json({ error: 'Method not allowed.' }, 405);
    } catch (error) {
      return error instanceof RequestError
        ? json({ error: error.message }, error.status)
        : json({ error: 'The dashboard could not confirm the request. Check Zoho before retrying an email.' }, 502);
    }
  },
};

import { files } from './dashboard.mjs';
