function dashboard() {
  const byId = id => document.getElementById(id);
  const status = byId('status');
  const customers = byId('customers');
  const invoices = byId('invoices');
  const email = byId('email');
  let selection;
  let emailPath;
  let revision = 0;

  async function api(path, options) {
    const response = await fetch(path, options);
    if (response.redirected) throw new Error('Reload the dashboard to renew your login.');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  }

  function button(parent, label, handler) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.onclick = handler;
    parent.append(item);
  }

  async function search(q, page) {
    const current = ++revision;
    selection = undefined;
    email.hidden = true;
    customers.replaceChildren();
    invoices.replaceChildren();
    status.textContent = 'Searching…';
    try {
      const data = await api('/api/customers?' + new URLSearchParams({ q, page }));
      if (current !== revision) return;
      status.textContent = data.customers.length ? '' : 'No customers found.';
      for (const customer of data.customers) {
        button(customers, customer.company && customer.company !== customer.name
          ? customer.name + ' | ' + customer.company : customer.name, () => loadInvoices(customer, 1));
      }
      if (page > 1) button(customers, 'Previous customers', () => search(q, page - 1));
      if (data.more) button(customers, 'More customers', () => search(q, page + 1));
    } catch (error) {
      if (current === revision) status.textContent = error.message;
    }
  }

  async function loadInvoices(customer, page) {
    const current = ++revision;
    selection = customer;
    email.hidden = true;
    invoices.replaceChildren();
    status.textContent = 'Loading invoices…';
    const path = '/api/customers/' + encodeURIComponent(customer.id) + '/invoices';
    try {
      const data = await api(path + '?page=' + page);
      if (current !== revision) return;
      const heading = document.createElement('h2');
      heading.textContent = customer.name + ' · Unpaid invoices';
      invoices.append(heading);
      status.textContent = data.invoices.length ? '' : 'No unpaid invoices on this page.';
      for (const invoice of data.invoices) {
        const row = document.createElement('div');
        const amount = Number(invoice.balance).toLocaleString(undefined, {
          minimumFractionDigits: 2, maximumFractionDigits: 2,
        });
        row.textContent = invoice.number + ' · ' + (invoice.due || 'No due date') + ' · ' +
          (invoice.currency || '') + ' ' + amount + ' ';
        const invoicePath = path + '/' + encodeURIComponent(invoice.id);
        const pdf = document.createElement('a');
        pdf.href = invoicePath + '/pdf';
        pdf.textContent = 'Download PDF';
        row.append(pdf);
        button(row, 'Email customer', () => preview(invoicePath + '/email'));
        invoices.append(row);
      }
      if (page > 1) button(invoices, 'Previous invoices', () => loadInvoices(selection, page - 1));
      if (data.more) button(invoices, 'More invoices', () => loadInvoices(selection, page + 1));
    } catch (error) {
      if (current === revision) status.textContent = error.message;
    }
  }

  async function preview(path) {
    const current = ++revision;
    email.hidden = true;
    status.textContent = 'Checking customer email…';
    try {
      const data = await api(path);
      if (current !== revision) return;
      emailPath = path;
      byId('to').value = data.to;
      byId('subject').value = data.subject;
      byId('message').value = 'Hello,\n\nHere is your Lester Digital invoice. Thank you for your business.';
      email.hidden = false;
      byId('subject').focus();
      status.textContent = '';
    } catch (error) {
      if (current === revision) status.textContent = error.message;
    }
  }

  byId('search').onsubmit = event => {
    event.preventDefault();
    search(byId('query').value.trim(), 1);
  };
  email.onsubmit = async event => {
    event.preventDefault();
    const send = byId('send');
    if (send.disabled || email.hidden) return;
    const to = byId('to').value;
    if (!confirm('Send this invoice email to ' + to + '?')) return;
    const current = revision;
    send.disabled = true;
    status.textContent = 'Sending…';
    try {
      await api(emailPath, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject: byId('subject').value, message: byId('message').value }),
      });
      if (current === revision) {
        email.hidden = true;
        status.textContent = 'Zoho accepted the email for delivery.';
      }
    } catch (error) {
      if (current === revision) status.textContent = error.message;
    } finally {
      send.disabled = false;
    }
  };
}

export const files = {
  '/': ['text/html; charset=utf-8', `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lester Digital Admin Dashboard</title>
<link rel="stylesheet" href="/dashboard.css">
<script src="/dashboard.js" defer></script>
</head>
<body><main>
<h1>Lester Digital Admin Dashboard</h1>
<form id="search">
<label for="query">Customer name</label>
<input id="query" required minlength="2" maxlength="100" autocomplete="off">
<button>Search</button>
</form>
<p id="status" role="status"></p>
<section id="customers" aria-label="Customer results"></section>
<section id="invoices" aria-label="Unpaid invoices"></section>
<form id="email" hidden>
<h2>Email customer</h2>
<label>To <input id="to" readonly type="email"></label>
<label>Subject <input id="subject" required maxlength="150"></label>
<label>Message <textarea id="message" required maxlength="5000" rows="5"></textarea></label>
<p>The customer’s payment portal link is added to the message.</p>
<button id="send">Send invoice email</button>
</form>
</main></body></html>`],
  '/dashboard.js': ['text/javascript; charset=utf-8', '(' + dashboard.toString() + ')();'],
  '/dashboard.css': ['text/css; charset=utf-8', `
body { font: 1rem system-ui, sans-serif; background: #f1f5f9; color: #172538; margin: 0; }
main { margin: 2rem auto; max-width: 58rem; padding: 0 1rem; }
form, section:not(:empty) { background: white; border-radius: .6rem; padding: 1rem; margin-bottom: 1rem; }
button, input, textarea { font: inherit; padding: .5rem; }
button { margin: .25rem; cursor: pointer; }
section div { padding: .45rem 0; border-bottom: 1px solid #dbe3ed; }
#email label { display: grid; margin: .7rem 0; max-width: 40rem; }
a { color: #174e89; margin-right: .5rem; }
`],
};
