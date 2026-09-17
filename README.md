# HDFC Expense Tracker

A local, single-user expense tracker for bank statements and banking alerts in Gmail. Amounts use INR and are stored as integer paise. Requires Node.js 24.13 or newer. PDF.js and SheetJS parse statements locally; no cloud hosting is required.

## Run and edit

Open this folder in VS Code. In its terminal:

```powershell
npm install
npm run dev
```

Open http://localhost:3000. Server edits restart automatically; refresh the browser after frontend edits. Use `npm start` without watch mode. F5 launches the included VS Code debugger. Do not start a second server on the same port. An optional `PORT` environment variable supports isolated local tests; Gmail OAuth still uses the configured redirect URI (3000 by default).

## PostgreSQL migration

Managed PostgreSQL support is prepared for the production persistence cutover. Set `DATABASE_URL` in `.env` to a managed PostgreSQL connection string, then run:

```powershell
npm run db:migrate
```

The migration creates the PostgreSQL schema and copies the local SQLite users, sessions, settings, transactions, categories, people, splits and import ledgers. It is idempotent and does not delete the SQLite database. Keep `data/` as a backup until the migrated row counts have been checked. When `DATABASE_URL` is set, the application uses the PostgreSQL runtime store; without it, local development continues to use SQLite.

For Vercel, also set `APP_ORIGIN` to the deployed HTTPS URL, `GOOGLE_REDIRECT_URI` to `${APP_ORIGIN}/auth/callback`, and `TOKEN_ENCRYPTION_KEY` to a base64 value generated from 32 random bytes. Keep `DATABASE_URL`, `DATABASE_SSL=true`, Google credentials, and the token key server-only environment variables.

## Upload bank statements

1. Click **Upload statement** beside **Add transaction**. Gmail is optional for local transactions, imports, categories, splits and analytics.
2. Choose a PDF, CSV, XLS or XLSX file (up to 10 MB), select HDFC, ICICI or Other, and optionally enter the last four account/card digits. Supply the password for an encrypted PDF.
3. Choose the worksheet and header row. Check the suggested Date, Description and Debit/Credit columns, or map a single Amount column with a Dr/Cr column or an explicit sign convention. Never map the running balance as the transaction amount. Numeric dates default to day/month/year; month/day/year is selectable. ISO and day-month-name dates are also supported.
4. Preview and correct dates, descriptions, amounts, types and categories. Select the rows to add. Selected expenses and received amounts are shown before import. **Import selected** saves confirmed transactions together and refreshes the ledger with all dates visible.

CSV supports comma, semicolon, tab and pipe delimiters, quoted fields, multiline descriptions, and UTF-8/UTF-16. Excel supports `.xls` and `.xlsx`, multiple sheets (one selected per import), and formatted Excel dates including the 1904 date system. Macros are not executed. For encrypted Excel workbooks, save an unencrypted `.xlsx` or CSV copy first.

PDF support covers selectable-text transaction tables with recognizable date, description and debit/credit or amount headings. It retains blank debit/credit cells, joins wrapped descriptions, and handles repeated page headers. It does not perform OCR or support every bank's PDF layout. Scanned/image-only pages and unrecognized tables produce an error; use the bank's CSV/Excel export or add entries manually. Always compare the extracted PDF row count and totals with the statement. Only INR is supported; decimal commas and foreign currency symbols require conversion/correction before import.

The same file and worksheet row cannot be imported twice, even after a rename, edits or a server restart. Other entries with matching bank, date, amount and type are flagged as **possible duplicates**, including Gmail entries and repeated rows within a statement; they start unchecked and can be explicitly selected for separate payments. Optional account digits narrow comparisons. This is a review aid, not proof that two entries are the same payment. Different exports or changed transaction details may need manual comparison.

Original file bytes and PDF passwords are not saved. The filename stays with imported transactions. Extracted tables are held in memory for up to 30 minutes (at most three previews), and cancelling discards the active preview. Limits: 5,000 transactions across a workbook, 50 columns, 20 sheets, 100 PDF pages, and 30 seconds per extraction. Parsing runs in a separate worker with a memory limit. Invalid selected rows reject the entire save; retrying a save cannot duplicate the same source rows.

SBI account-summary PDFs with graphic table headings are also supported when their seven-column layout and statement summary can be recognized. The importer checks debit/credit counts and totals against the summary before opening the preview. Select **Other** as the bank for SBI statements.

To remove a duplicate, click **Delete** on its transaction row and confirm. This removes the transaction and any split, and refreshes totals. Deletion cannot be undone. The same Gmail message or statement file/worksheet row stays excluded on later imports; a different export may still contain the same payment.

Parser references: [SheetJS installation](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/) and [PDF.js document API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html).

```text
public/             Browser UI: HTML, CSS and JavaScript
src/server.js       HTTP routes, local request protection, OAuth callback
src/gmail.js        Google token exchange and Gmail sync
src/parser.js       HDFC alert extraction and MIME handling
src/store.js        SQLite schema and encrypted token storage
tests/              Synthetic parser fixtures; no real banking data
.vscode/            Editor and debugger configuration
.env.example        Credential variable names
data/               Generated database and token key; ignored by Git
```

Modules use standard JavaScript ESM. Comments explain constraints and non-obvious decisions. Keep credentials and banking data out of source control.

## Connect your Gmail account

1. Open https://console.cloud.google.com/ and create or select your own project.
2. Enable **Gmail API** under APIs & Services > Library.
3. Open **Google Auth Platform**. Configure the app name, support email, and developer contact. Choose External audience and keep it in Testing. Add your Gmail address as a test user.
4. Under Data Access, add `https://www.googleapis.com/auth/gmail.readonly`.
5. Under Clients, create a **Web application** OAuth client. Add this exact authorized redirect URI: `http://localhost:3000/auth/callback`.
6. Copy `.env.example` to `.env` and fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. These belong in your local file, not in chat or browser code.
7. Restart the server. Click **Connect Gmail**, select your account, and approve access. Then click **Sync now**.

Google Testing mode Gmail refresh tokens normally expire after seven days. Use Reconnect Gmail when needed. Read-only permission covers the mailbox; the app filters for HDFC sender domains and transaction language. It cannot send or delete emails. No Gmail connector/plugin is required.

References: https://developers.google.com/identity/protocols/oauth2/web-server and https://developers.google.com/workspace/gmail/api/auth/scopes

## MVP behavior and limits

- The table shows the alert's transaction time in IST when supplied. Missing times remain blank; Review allows manual entry. The next sync backfills times for existing alerts in the import window without changing confirmed amounts or categories.
- The left sidebar shows your connected Gmail address. **Edit profile** saves your name and an optional local photo (PNG/JPEG/WebP, up to 250 KB); it does not fetch your Google profile photo.
- Add people in the sidebar, confirm an expense, then choose **Split**. Equal and percentage splits include you plus selected people. Percentage shares must total 100%; rounding preserves the total in paise. Choose who paid, preview the allocation, and save. Splits can be changed or removed.
- Sidebar balances are all-time amounts between you and each person: positive means they owe you, negative means you owe them. Debts among other participants are not shown. This is a local ledger; it does not send requests or move money. Settlement tracking is not included yet.
- The main overview retains the full confirmed bank expense amounts. **Deep dive** is a second in-page view showing your personal expense share after splits, confirmed income/refunds, six-month trends, month-over-month change and category totals. Unreviewed transactions are excluded. A split does not create income. Imported debits default to you as payer; selecting someone else is an explicit manual allocation, not inferred from the bank email.
- Remove a split before changing its underlying amount or changing the transaction away from an expense, so saved shares cannot go out of balance.

- Saving or cancelling a review preserves the page and horizontal table scroll position. Rows refresh together to avoid collapsing the table.
- Category icons use Google Material Symbols with a labeled icon picker. Internet, Mobile & phone, Electricity, Water and Gas are included. Existing emoji icons migrate without changing category names. The icon font loads from Google Fonts and needs internet access; labels remain readable without it. See https://developers.google.com/fonts/docs/material_symbols.

- Review transaction includes common categories with icons. Use **Add a category** to save a custom name and icon locally, then select it for any transaction.
- **Auto-confirm clear expenses on sync** is enabled by default and can be switched off. Known merchant rules suggest categories. Automatic confirmation requires a recognized credit-card/UPI format, a valid transaction date, account digits, one amount and a single matching merchant rule. Unknown merchants, ambiguous amounts and credits remain for review. This is a heuristic, not bank verification; auto-confirmed entries remain editable.
- The first sync after this update rechecks pending alerts in the import window. Confirmed entries and your edits are preserved. Custom category creation does not add an automatic merchant rule.

- First sync scans roughly 90 days plus a two-day overlap. Later syncs start two days before the last successful sync. Message IDs prevent repeated imports. A failed sync can safely be retried.
- Imports use HDFC sender domains `hdfcbank.net` and `hdfcbank.com`, plus `alerts@hdfcbank.bank.in`, `credit_cards@icici.bank.in` and `cbsalerts.sbi@alerts.sbi.bank.in`. The first sync after this sender update rescans the last 90 days plus overlap; already imported message IDs are skipped. Sender filtering is not proof of email authenticity. Check the original alert before confirming.
- All imported candidates require review. Confirm date, amount, merchant, type and category. Only confirmed entries appear in money totals. Recognized HDFC alerts use the transaction date (for example, `08 Sep, 2026`); other formats fall back to email receipt date in UTC.
- The Gmail parser supports the supplied HDFC credit-card debit format, including `towards` merchant names, masked card digits and transaction dates. Regression tests cover this format and HTML formatting; live Gmail access still requires your connection. Unknown alert formats are skipped; multiple amounts require review. Gmail attachments are not parsed automatically; download statements and use **Upload statement**.
- Separate alerts about the same payment may appear twice. Mark duplicates as **Ignore / duplicate**. Transfers and card repayments are excluded from expenses. Refunds appear under money received.
- Search and monthly filtering are included. The Deep dive analytics cockpit includes spend trends, growth, averages, category and payment-method mix, budgets, behavior patterns, income and savings, anomaly flags, and month-end projections. Categories remain editable.
- Gmail sync uses email alerts, not a direct bank connection. Statement uploads and manual entries can fill gaps in email coverage.
- One Gmail account per database. Disconnect revokes Google access and removes tokens. Transaction history, imports and local editing remain available on this computer. To start over, stop the server and deliberately remove the local `data/` folder.
- The server listens only on loopback and accepts `localhost:3000`. Do not expose this service on a network. Tokens use AES-256-GCM; the key is a separate file in `data/`. This protects a database-only copy, not someone with access to the whole folder. SQLite transaction data is not encrypted. Protect your Windows account and disk.

## Verify

```powershell
npm test
npm run check
```

The tests cover synthetic INR parsing, OTP exclusion, refund classification, ambiguous amounts, MIME alternatives, CSV normalization, generated PDF tables, XLS/XLSX date systems, atomic statement saves, persistence, duplicate detection and safe retries. End-to-end Gmail verification requires your configured OAuth client and consent.
