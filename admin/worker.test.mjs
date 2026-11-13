import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFArray, PDFDict, PDFName, PDFString } from 'pdf-lib';
import worker from './worker.mjs';

test('Access, search, invoice ownership, linked PDF, and email boundaries', async t => {
  const origin = 'https://admin.example.com';
  const ctx = { access: { aud: 'app', getIdentity: async () => ({ email: 'admin@example.com' }) } };
  let portalInvoice = '20';
  const env = {
    ACCESS_AUD: 'app', ADMIN_EMAIL: 'admin@example.com',
    PAYMENT_API: { fetch: async url => {
      assert.equal(new URL(url).searchParams.get('token'), 'opaque-example');
      return Response.json({ invoices: [{ invoice_id: portalInvoice }] });
    } },
  };
  const invoice = { invoice_id: '20', customer_id: '10', invoice_number: 'INV-20', status: 'sent', balance: 25 };
  const source = await PDFDocument.create();
  source.addPage();
  const pdfBytes = await source.save();
  let sent;
  let upstream = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    upstream++;
    const url = new URL(input);
    if (url.hostname === 'accounts.zoho.com') return Response.json({ access_token: 'fixture' });
    assert.equal(options.headers.Authorization, 'Zoho-oauthtoken fixture');
    const ok = data => Response.json({ code: 0, ...data });
    switch (url.pathname) {
      case '/books/v3/contacts':
        assert.equal(url.searchParams.get('contact_name_contains'), 'Sample & Co');
        assert.equal(url.searchParams.get('contact_type'), 'customer');
        return ok({ contacts: [{ contact_id: '10', contact_name: 'Sample & Co', email: 'private@example.com' }] });
      case '/books/v3/contacts/10':
        return ok({ contact: { contact_id: '10', contact_type: 'customer', email: 'client@example.com',
          custom_fields: [{ label: 'Portal Token', value: 'opaque-example' }] } });
      case '/books/v3/invoices':
        return ok({ invoices: [invoice, { ...invoice, status: 'paid' }, { ...invoice, customer_id: '11' }] });
      case '/books/v3/invoices/20':
        return options.headers.Accept === 'application/pdf'
          ? new Response(pdfBytes, { headers: { 'Content-Type': 'application/pdf' } }) : ok({ invoice });
      case '/books/v3/invoices/20/email':
        sent = JSON.parse(options.body);
        return ok({});
      default: throw new Error('Unexpected upstream request');
    }
  });
  const run = (path, options, context = ctx) => worker.fetch(new Request(origin + path, options), env, context);
  assert.equal((await run('/api/customers?q=Sample', {}, {})).status, 403);
  assert.equal((await run('/', {}, { access: { ...ctx.access, aud: 'wrong' } })).status, 403);
  assert.equal((await run('/', {}, { access: { ...ctx.access, getIdentity: async () => ({email: 'other@example.com'}) } })).status, 403);
  assert.equal(upstream, 0);
  assert.equal((await run('/')).status, 200);
  const search = await run('/api/customers?q=Sample%20%26%20Co');
  assert.equal(search.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual((await search.json()).customers, [{ id: '10', name: 'Sample & Co' }]);
  assert.equal((await (await run('/api/customers/10/invoices')).json()).invoices.length, 1);
  assert.equal((await run('/api/customers/11/invoices/20/pdf')).status, 404);
  const path = '/api/customers/10/invoices/20';
  portalInvoice = '21';
  assert.equal((await run(path + '/pdf')).status, 409);
  portalInvoice = '20';
  const pdf = await PDFDocument.load(await (await run(path + '/pdf')).arrayBuffer());
  assert.equal(pdf.getPageCount(), 2);
  const annotation = pdf.getPage(1).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
  const uri = annotation.lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('URI'), PDFString);
  assert.equal(uri.decodeText(), 'https://ldrpzl3672.github.io/ldr-payment-portal/?token=opaque-example');
  assert.equal((await (await run(path + '/email')).json()).to, 'client@example.com');
  const post = (to, from = origin) => run(path + '/email', {
    method: 'POST', headers: { Origin: from, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, subject: 'Invoice', message: 'Hello <customer>' }),
  });
  assert.equal((await post('client@example.com', 'https://other.example')).status, 403);
  assert.equal((await post('other@example.com')).status, 409);
  assert.equal(sent, undefined);
  assert.equal((await post('client@example.com')).status, 200);
  assert.deepEqual(sent.to_mail_ids, ['client@example.com']);
  assert.match(sent.body, /Hello &lt;customer&gt;/);
  assert.match(sent.body, /token=opaque-example/);
});
