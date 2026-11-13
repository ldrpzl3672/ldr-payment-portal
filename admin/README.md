# Lester Digital Admin Dashboard

The separate admin Worker uses the existing Cloudflare Access application. Set
`ACCESS_AUD` to that application's audience and `ADMIN_EMAIL` to the sole
administrator's email. The Worker requires both to match the authenticated
Cloudflare request context. The sample Wrangler configuration is for review
against the deployed Worker settings before use.

Configure the admin Worker's `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`,
`ZOHO_REFRESH_TOKEN`, and `ZOHO_ORGANIZATION_ID`. The US Zoho endpoints need
contacts READ, invoices READ, and invoices CREATE for email. The existing
`PAYMENT_API` binding verifies that the Zoho contact's Portal Token exposes the
selected invoice through the customer portal.

Downloads preserve the Zoho invoice pages and append a clickable payment page.
Email uses Zoho Books' invoice email endpoint with an editable message and the
same custom portal link. The preview and send request use the primary Zoho
contact email. Verify the organization sender and Zoho's standard invoice
attachment with an authorized test recipient before using customer email.

Run `npm ci` and `npm test` in this directory. Before deploying, compare the
live routes, Access policy, and bindings with the intended configuration and
retain the current Worker version for rollback. Verify Access denial and an
authenticated search and download in a protected environment, then run the
authorized email smoke test. The payment Worker and Pages source are outside
this deployment.
