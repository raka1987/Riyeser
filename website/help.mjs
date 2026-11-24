// Help Centre text: one guide per program, written from what each program's screens and menus actually say.
// Button and menu names are in <b>bold</b> exactly as they appear in the program. Keep answers short and plain.
// Each guide: { id, name, intro, groups: [{ title, items: [[anchor, question, answerHtml, popular?]] }] }.

export function helpGuides({ EMAIL, SERVICES_APP, up }) {
  const tip = (t) => `<p class="tip">💡 ${t}</p>`;
  const warn = (t) => `<p class="warn">⚠️ ${t}</p>`;
  return [
    {
      id: 'start', blurb: 'Set up Riyeser and get going quickly.', app: 'central', name: 'Getting started', short: 'Getting started',
      intro: 'Downloading, installing, updates, your free trial and licence, and moving to a new computer.',
      groups: [
        { title: 'Installing', items: [
          ['install', 'How do I install a Riyeser program?', `<ol><li>Go to <a class="more" href="${up}downloads.html">Downloads</a> and click <b>Download</b> next to the program.</li><li>Open the file when it finishes downloading.</li><li>It installs itself in a few seconds and puts an icon on your desktop. There are no questions to answer.</li></ol>${tip('New here? Install <b>Riyeser Central</b> first. It is the home screen for every other Riyeser program.')}`, true],
          ['smartscreen', 'Windows says “Windows protected your PC”', `<p>Click <b>More info</b>, then <b>Run anyway</b>. Windows shows this for new programs until they are digitally signed, which we are arranging. It is safe to continue if you downloaded the file from riyeser.com.</p>`, true],
          ['admin', 'Do I need an administrator password?', '<p>No. Each program installs just for your own Windows user, so you don\'t need admin rights.</p>'],
          ['windows', 'What computer do I need?', '<p>A PC with Windows 10 or Windows 11. The programs work without internet once they are installed.</p>'],
          ['uninstall', 'How do I uninstall a program?', '<p>Open Windows <b>Settings → Apps → Installed apps</b>, find the program and choose <b>Uninstall</b>. Your books, payroll records and documents are not deleted.</p>'],
        ] },
        { title: 'Updates', items: [
          ['updates', 'How do I update my programs?', `<ol><li>Open <b>Riyeser Central</b>. It checks for updates by itself.</li><li>When one is ready you'll see <b>An update is ready</b>. Click <b>Update</b> (or <b>Update all</b>).</li><li>Programs being updated close for a moment and open again. Your information is kept.</li></ol><p>To check straight away, click <b>Check for updates</b> at the bottom of Riyeser Central. You can also download the newest version from <a class="more" href="${up}downloads.html">Downloads</a> and run it over the old one.</p>`, true],
        ] },
        { title: 'Free trial and licence', items: [
          ['trial', 'How does the free trial work?', '<p>Riyeser Central, Riyeser Invoices, Riyeser Team, PDF and Desk Assistant are free forever. Every paid program — <b>Accounting Basics</b>, Accounting Plus, Payroll, <b>Riyeser POS</b>, Bookings, and As Built for the building industry — is free for 90 days. No card and no sign-up. Each program shows how many days are left.</p><p>When the trial ends nothing is deleted and nothing is charged. Only new invoices (Basics), new till sales (POS) or the screens of the other programs wait until you enter a licence key in Riyeser Central.</p>', true],
          ['licence', 'How do I enter my licence key?', `<ol><li>Open <b>Riyeser Central</b> and click <b>Licence</b> at the bottom of the screen.</li><li>Paste the key from your receipt email into <b>Have a licence key?</b></li><li>Click <b>Turn on licence</b>.</li></ol><p>One licence covers every Riyeser program for that person. To buy one, click <b>See plans &amp; buy</b> or see <a class="more" href="${up}pricing.html">Pricing</a>.</p>`, true],
          ['licence-move', 'Moving my licence to another computer', '<p>On the old computer open Riyeser Central → <b>Licence</b> → <b>Remove licence from this PC</b>. That frees its place. Then enter the same key on the new computer.</p>'],
        ] },
        { title: 'New computer', items: [
          ['new-pc', 'Moving to a new computer', `<ol><li>Install the programs on the new computer.</li><li><b>Accounting:</b> copy the <code>.riyeser</code> folder from your Windows user folder (it holds <code>company.db</code>) to the same place on the new computer.</li><li><b>Payroll:</b> on the old computer choose <b>Payroll → Back up now</b>. Copy the newest file from <code>Documents\\Riyeser\\Payroll\\Backups</code> to the new computer, then in Payroll choose <b>Payroll → Restore from a backup…</b></li><li><b>Licence:</b> remove it from the old PC and enter it on the new one (see above).</li></ol><p>Email <a class="more" href="mailto:${EMAIL}">${EMAIL}</a> if you'd like a hand.</p>`],
        ] },
      ],
    },
    {
      id: 'central', blurb: 'Your home screen, programs and updates.', app: 'central', name: 'Riyeser Central',
      intro: 'Your home screen: money owed, today\'s meetings, to-dos, recent files, one search box, and every Riyeser program one click away.',
      groups: [
        { title: 'The home screen', items: [
          ['tour', 'What\'s on the home screen?', '<ul><li><b>Search box</b> at the top: finds any file by its name, the words inside it, a company, or a name it used to have.</li><li><b>Program tiles</b>: click one to open that program.</li><li><b>💲 Money</b>: what customers owe you, what you owe, and what\'s overdue, with who to chase first. It comes from Riyeser Accounting.</li><li><b>📅 Today</b>: your meetings today and tomorrow, from the calendars you connect in Desk Assistant.</li><li><b>✅ To-do</b>: your to-do list from Desk Assistant.</li><li><b>Recent documents</b>: the files you opened last.</li></ul>', true],
          ['dark', 'Switch between light and dark', '<p>Click the <b>☾</b> button at the top right. Click it again to go back.</p>'],
          ['search', 'Search all my files', '<p>Type in the search box at the top. The search uses the file list that Riyeser Desk Assistant builds, so install Desk Assistant and let it read your folders first.</p>'],
        ] },
        { title: 'Programs', items: [
          ['add-program', 'Get another Riyeser program', '<p>Under <b>More Riyeser apps</b>, click <b>Get it</b> next to the program. Its download page opens. Once it\'s installed it appears on the home screen by itself.</p>'],
          ['locate', 'A program I installed isn\'t showing', '<p>Under <b>More Riyeser apps</b>, click <b>Locate…</b> next to its name and pick the program (or its desktop shortcut). Central remembers it from then on.</p>', true],
          ['updates', 'Updating programs', `<p>Central checks for updates and shows <b>An update is ready</b>. Click <b>Update all</b>. See <a class="more" href="${up}help/start.html#updates">How do I update?</a></p>`],
          ['licence', 'Trial days and licence', `<p>Click <b>Licence</b> at the bottom of Central to see your trial days left, enter a licence key, or remove the licence from this PC. See <a class="more" href="${up}help/start.html#licence">How do I enter my licence key?</a></p>`],
        ] },
        { title: 'Something\'s not right', items: [
          ['money-empty', 'The Money panel is empty', '<p>It reads from Riyeser Accounting. If it says <b>Open Accounting and set up your company to see money owed and owing here</b>, open Accounting, create your company and enter an invoice or bill. The totals then show in Central.</p>'],
          ['no-meetings', 'My meetings don\'t show under Today', `<p>Open <b>Desk Assistant → ⚙ Settings → Calendars</b> and paste your calendar's secret iCal address. See <a class="more" href="${up}help/desk-assistant.html#calendar">Connect my calendar</a>.</p>`],
        ] },
      ],
    },
    {
      id: 'invoices', blurb: 'Free quotes, invoices and getting paid.', app: 'invoices', name: 'Riyeser Invoices',
      intro: 'Free invoicing, as its own app: quotes, invoices, customers and getting paid. It opens the same company file as Riyeser Accounting, so moving up to Accounting Basics later loses nothing.',
      groups: [
        { title: 'Getting started', items: [
          ['open', 'Install and open Riyeser Invoices', '<ol><li>Download <b>Riyeser Invoices</b> from the Downloads page, or click <b>Get more apps</b> in Riyeser Central.</li><li>Open it from the desktop, the Start menu or Riyeser Central.</li><li>First time? Enter your business name and a password for the administrator. Add your ABN, address and invoice numbering under <b>Setup → Company details</b>.</li></ol>', true],
          ['free', 'Is it really free?', '<p>Yes. Riyeser Invoices is free forever, with no time limit, no card and no limit on invoices or customers.</p>'],
        ] },
        { title: 'Invoices and payments', items: [
          ['invoice', 'Send an invoice', '<ol><li>Click <b>+ New → Invoice</b>.</li><li>Choose the customer (or <b>+ new customer</b>), add a line for each thing you charge for, and check the GST.</li><li>Click <b>Save</b>, then <b>Save PDF</b> to email or print it.</li></ol>', true],
          ['quote', 'Quote first, then invoice', '<p>Click <b>+ New → Quote</b> and save it. When the customer says yes, open the quote and click <b>Convert to invoice</b>.</p>'],
          ['paid', 'Record a payment', '<p>Click <b>Sales → Receive payments</b>, choose the customer, tick the invoices being paid and enter the amount. Part payments are fine.</p>'],
          ['owed', 'See who owes me', '<p>Open <b>Reports → Who owes me</b> for every unpaid invoice by customer and how overdue it is.</p>'],
          ['more', 'I need stock, bills or a Profit &amp; Loss', '<p>Install <b>Accounting Basics</b>. It opens the same company file, so every customer, invoice and payment is already there. It\'s free for 90 days, then $20 a month per business. Click <b>Setup → Need stock or bills?</b> in Riyeser Invoices for the download.</p>'],
        ] },
      ],
    },
    {
      id: 'bookings', blurb: 'Jobs, appointments and table bookings.', app: 'bookings', name: 'Riyeser Bookings', badge: ['trial', '90 days free'],
      intro: 'Book and schedule trades jobs, appointments or restaurant tables, as its own app. It opens the same company file as Riyeser Accounting, Invoices and POS, so customers are shared and invoices appear there straight away. Free for 90 days.',
      groups: [
        { title: 'Getting started', items: [
          ['open', 'Install Bookings and choose your kind of business', '<ol><li>Download <b>Riyeser Bookings</b> from the Downloads page, or click <b>Get more apps</b> in Riyeser Central.</li><li>Open it and go to <b>Setup → Bookings setup</b>.</li><li>Choose <b>Trades &amp; site jobs</b>, <b>Appointments</b> or <b>Restaurant tables</b>, and your opening hours.</li><li>Name your staff (or tables, with their seats), and add the job types or services you offer with how long they take and their price.</li><li>Click <b>Save</b>.</li></ol>', true],
        ] },
        { title: 'Booking', items: [
          ['book', 'Make a booking', '<ol><li>On the <b>Day</b> view, click an empty time in the right staff member\'s or table\'s column (or click <b>+ New</b>).</li><li>Choose the customer, or type a new customer\'s name and phone.</li><li>Pick the job type or service: the time it takes fills in by itself. Add the job address or number of people if needed.</li><li>Click <b>Save</b>.</li></ol><p>If that person or table is already booked then, Bookings tells you. Tick <b>Allow double-booking</b> only if you really mean it.</p>', true],
          ['status', 'Confirm, start, finish or cancel', '<p>Open the booking and click <b>Confirm</b>, <b>Start</b> or <b>Mark done</b>. <b>Cancel this booking</b> and <b>Didn\'t show</b> keep it on record, crossed out on the calendar.</p>'],
          ['invoice', 'Invoice a job or appointment', '<p>Open it and click <b>Invoice this job</b>. A real invoice is made for the customer with the service\'s price and GST. Check it, then save a PDF or send it. It\'s in Riyeser Accounting and Invoices too. <b>List → Done, not invoiced yet</b> shows everything still waiting for an invoice.</p>', true],
          ['online', 'Can customers book online?', '<p>Not yet: bookings are made by your staff in the app for now. Online booking for customers is the next step.</p>'],
        ] },
      ],
    },
    {
      id: 'team', blurb: 'Team chat: channels and direct messages.', app: 'team', name: 'Riyeser Team',
      intro: 'Free team chat for your business, online so everyone can use it on the PC (Team chat in Riyeser Central) or a phone (riyeser.com/team). Each business only sees its own team.',
      groups: [
        { title: 'Getting started', items: [
          ['start', 'Start a team for your business', '<ol><li>Click <b>Team chat</b> in Riyeser Central, or open <b>riyeser.com/team</b> on any device.</li><li>Click <b>Create an account</b>, enter your work email and a password, and confirm your email from the link we send.</li><li>Sign in, then under <b>Start a team for your business</b> enter the business name and your name.</li><li>You start with <b>#general</b> and <b>#jobs</b>. Add more channels with <b>+</b>.</li></ol>', true],
          ['invite', 'Invite your staff', '<p>Click <b>+ Invite people</b> and send them the link. They create a free account and join with the code in the link. Owners and admins can click <b>New code</b> to stop the old link working.</p>', true],
        ] },
        { title: 'Chatting', items: [
          ['private', 'Make a private chat (executives, sales, managers)', '<ol><li>Click <b>+</b> next to Channels.</li><li>Give it a name, for example <b>executives</b> or <b>sales</b>.</li><li>Leave <b>Only people I choose</b> ticked (it\'s the default) and tick the people who should be in it.</li><li>Click <b>Add</b>.</li></ol><p>A private chat shows a 🔒. It doesn\'t show up at all for anyone who isn\'t in it, so nobody else even knows it\'s there. To change who\'s in it later, open it and click <b>People</b>: whoever made it, or a team owner or admin, can tick or untick people. Anyone in it can click <b>Leave this chat</b>.</p>', true],
          ['dm', 'Send a private message', '<p>Click a person under <b>Direct messages</b>. Only the two of you can read it.</p>'],
          ['refs', 'Point at an invoice or job', '<p>Type the number the way Riyeser shows it, for example <b>INV-1047</b>, <b>Q-0042</b> or <b>Booking 12</b>, and it stands out in the message. Type <b>@</b> and a name to get someone\'s attention.</p>'],
          ['edit', 'Change or delete a message', '<p>Point at your message (or tap it on a phone) and click <b>Edit</b> or <b>Delete</b>. Edited messages say “(edited)”.</p>'],
        ] },
        { title: '⭐ Team Calls (premium)', items: [
          ['calls-setup', 'Set up branches and extensions', '<ol><li>When you start a team you get <b>Head office</b> on <b>100</b>, and you\'re on <b>101</b>.</li><li>Click <b>⚙</b> next to Calls (owners and admins), type a branch name such as <b>Lautoka branch</b> and click <b>+ Add branch</b>. It gets the next number (200, 300…) and its own join code, like <b>LAU-4821</b>.</li><li>Give each branch\'s staff their branch code. When they join with it they go straight into that branch with the next extension (201, 202…).</li><li>To change someone\'s number, type it under <b>Extensions</b> and click <b>Save extensions</b>.</li></ol><p>There\'s nothing to set up on the devices: whatever PC or phone someone is signed in on is their extension. A shared front-desk PC can sign in as, for example, “Lautoka front desk”.</p>', true],
          ['calls-make', 'Make a call', '<p>Open someone\'s direct message and click <b>📞 Call</b>, click a branch under <b>Calls</b> to ring everyone there (the first to answer takes it), or click <b>⌨</b> and dial an extension. In a call you can <b>Mute</b>, turn the <b>Camera</b> on, and <b>Hang up</b>. A note like “📞 Call · 3:12” or “📞 Missed call” is left in your messages.</p>', true],
          ['calls-ring', 'Make sure calls ring', '<p>Calls ring wherever Riyeser Team is open. On a PC, open <b>Team chat</b> in Riyeser Central once: after that it keeps running in the background while Central is open, and pops up when someone calls. On a phone, keep riyeser.com/team open. The first time, allow the microphone when asked.</p>'],
          ['calls-price', 'What do calls cost?', '<p>Team Calls is <b>+$20 a month per business</b>, free for your team\'s first 90 days. There are no call charges: calls go over your internet. Chat stays free either way.</p>'],
        ] },
      ],
    },
    {
      id: 'accounting-basics', blurb: 'Invoices, stock and reports.', app: 'accounting-basics', name: 'Accounting Basics', badge: ['trial', '90 days free'],
      intro: 'Invoicing, quotes, customers, suppliers and stock, free for 90 days. Everything here also works the same way in Accounting Plus. For a till, see Riyeser POS.',
      groups: [
        { title: 'Getting started', items: [
          ['first-company', 'Setting up my company', `<ol><li>Open Accounting Basics. It asks you to <b>Create company file</b>.</li><li>Type your <b>Company name</b> and choose an <b>Admin password</b>. Leave <b>Load demo data</b> unticked to start empty (tick it if you just want to look around).</li><li>Go to <b>Setup → Company &amp; preferences</b> and enter your ABN, address and when your financial year starts.</li><li>Add your customers, suppliers and stock items, then start invoicing.</li></ol>${tip('Already trading? Enter your bank balances under <b>Setup → Chart of accounts</b>, and the opening quantity and cost on each new stock item.')}`, true],
          ['home', 'What does the Home screen show?', '<p>Your cash, who owes you, bills that are due and stock that is running low. Use <b>+ New</b> at the top to start an invoice, quote, bill, money in or out, customer or supplier.</p>'],
        ] },
        { title: 'Invoices, quotes and customers', items: [
          ['invoice', 'Make an invoice', '<ol><li>Click <b>Sales → New invoice</b> (or <b>+ New → Invoice</b>).</li><li>Choose the customer, then add a line for each thing you sold. Picking a stock item fills in the price and GST for you.</li><li>Tick <b>Prices include GST</b> if your prices already include GST.</li><li>Save it. Click <b>Download PDF</b> to get a copy you can email.</li></ol>', true],
          ['quote', 'Make a quote and turn it into an invoice', '<p>Click <b>Sales → New quote</b>. When the customer says yes, open the quote and press <b>Convert to invoice</b>.</p>'],
          ['payment', 'Record a payment from a customer', '<ol><li>Click <b>Sales → Receive payments</b>.</li><li>Pick the customer and type what they paid against each invoice. One payment can cover several invoices.</li><li>Save. The invoices show as paid.</li></ol>', true],
          ['mistake', 'I made a mistake on an invoice', '<p>A saved invoice can\'t be edited, so your records stay honest. <b>Void</b> it (this reverses it and puts any stock back) and enter it again. If a payment was recorded on it, void the payment first.</p>'],
          ['statement', 'Send a customer a statement', '<p>Open the customer under <b>Sales → Customers</b> and click <b>Statement</b>. It shows everything they owe.</p>'],
        ] },
        { title: 'Stock and suppliers', items: [
          ['stock-item', 'Add a stock item', '<ol><li>Click <b>Stock → New item</b>.</li><li>Enter its name and buy and sell prices. Tick <b>I inventory this item</b> to keep count of how many you have.</li><li>Set a <b>reorder level</b> to be warned when it runs low, and a <b>Category</b> (e.g. Coffee) to choose its tab on the shop counter.</li></ol>'],
          ['receive-stock', 'Enter a supplier\'s bill', '<p>Click <b>Stock → Receive stock (bill)</b>, choose the supplier and add the items and quantities. Your stock goes up and the bill shows as owing. When you pay it, use <b>Pay bills</b>.</p>'],
          ['stocktake', 'Do a stocktake', '<p>Click <b>Stock → Stocktake</b> and type what you counted. The differences are recorded for you.</p>'],
          ['reorder', 'See what needs reordering', '<p>Items under their reorder level show on the Home screen. Set the level on each stock item.</p>'],
        ] },
        { title: 'Selling at a counter', items: [
          ['register', 'Sell at the counter', '<p>The till is its own app, <b>Riyeser POS</b>. Click <b>Riyeser POS</b> in the Accounting menu to open it, or to download it. See the <a class="more" href="pos.html">Riyeser POS guide</a>. Till sales show in Accounting as paid invoices.</p><ol><li>In Riyeser POS, tap <b>Sell</b>. It opens full screen.</li><li>Choose <b>Retail</b> or <b>Restaurant</b> at the top.</li><li><b>Retail</b>: scan a barcode, type a code and press Enter, or tap the item tiles. <b>Park sale</b> holds a sale while the customer fetches something.</li><li><b>Restaurant</b>: choose <b>Dine in</b> and a table, or <b>Takeaway</b>. <b>Send to kitchen</b> prints a docket.</li><li>Press <b>Pay</b>, choose Cash or Card. For cash, tap an amount and the change is shown. The receipt prints by itself.</li></ol>', true],
          ['end-of-day', 'End-of-day totals', '<p>In Riyeser POS, open <b>Sales</b> for the day\'s takings by cash and card, and <b>Close till</b> to count the drawer.</p>'],
        ] },
        { title: 'Money in and out', items: [
          ['money', 'Record spending or money received', '<p>Use <b>Money → Money out</b> for things like rent or bank fees, and <b>Money → Money in</b> for money that isn\'t for an invoice. GST is worked out for you; untick it if the amount has no GST.</p>'],
        ] },
        { title: 'Reports', items: [
          ['reports', 'Find, print or export a report', '<p>Click <b>Reports → All reports</b>. Every report can be filtered by date, printed, and exported to CSV to open in Excel or send to your accountant. Click a line to see the transactions behind it.</p>', true],
          ['which-report', 'Which report do I need?', '<ul><li><b>Who owes me</b>: unpaid invoices, grouped by how overdue they are.</li><li><b>Profit &amp; loss</b>: what you earned and spent.</li><li><b>GST summary</b>: the figures for your BAS.</li><li><b>Inventory report</b>: what stock you have and what it\'s worth.</li><li><b>Sales by item</b>: what sells best.</li></ul>'],
        ] },
        { title: 'Users, passwords and backups', items: [
          ['password', 'I forgot my password', '<ol><li>On the sign-in screen, click <b>Forgot password?</b></li><li>Choose your username and a new password.</li></ol><p>This works in the Accounting program on the computer that holds your company file, so nobody elsewhere can use it. Your books are not changed. For staff, an administrator can set a new password under <b>Setup → Users &amp; roles</b>.</p>', true],
          ['users', 'Add a staff member and limit what they see', '<ol><li>Sign in as the administrator and open <b>Setup → Users &amp; roles</b>.</li><li>Add the person, then choose a level for each area: <b>Hidden</b>, <b>View</b>, <b>Add &amp; edit</b> or <b>Full</b>. Or click a quick set such as <b>Sales staff</b> or <b>Read-only</b>.</li><li>Click <b>Save</b>.</li></ol>'],
          ['backup', 'Back up my books', `<p>All your books are in one file: <code>company.db</code> in the <code>.riyeser</code> folder in your Windows user folder. Copy it to a USB stick or cloud drive now and then.</p>${warn('Close Accounting before you copy the file.')}`],
        ] },
        { title: 'Moving up to Plus', items: [
          ['upgrade', 'I need bank reconciliation, payroll or a Balance Sheet', `<p>Click <b>Setup → Upgrade to Accounting Plus</b> and install Accounting Plus. It replaces Basics and opens your books exactly as they are. Plus is free for 90 days, then included in your Riyeser licence. See <a class="more" href="${up}help/accounting.html">the Accounting Plus guide</a>.</p>`],
          ['diagnostics', 'Still stuck?', `<p>Open <b>Setup → Support diagnostics</b>, press <b>Download</b>, and email the file to <a class="more" href="mailto:${EMAIL}">${EMAIL}</a> with your question. It contains no customer or bank details.</p>`],
        ] },
      ],
    },
    {
      id: 'accounting', blurb: 'Banking, BAS, journals and several companies.', app: 'accounting', name: 'Accounting Plus', badge: ['trial', '90 days free'],
      intro: 'Full books: everything in Basics, plus banking and reconciliation, payroll, journals, jobs, budgets, BAS and every report.',
      groups: [
        { title: 'Basics and Plus', items: [
          ['everyday', 'Invoices, quotes and stock', `<p>These work exactly as in Basics. See the <a class="more" href="${up}help/accounting-basics.html">Accounting Basics guide</a> for invoices, payments, stock and passwords. The till is its own app: see the <a class="more" href="${up}help/pos.html">Riyeser POS guide</a>.</p>`],
          ['switch', 'Moving between Basics and Plus', '<p>Basics (green <b>B</b>) and Plus (blue <b>P</b>) are two separate apps that open the same books. Install the other one and it replaces the first, with your customers, invoices and stock carried over. Plus-only records (payroll, journals, jobs, budgets) are kept safe in Basics and come back in Plus. In Plus you\'ll find this under <b>Setup → Basics or Plus</b>.</p>', true],
          ['trial-end', 'What happens when the free trial ends?', '<p>Your everyday screens keep working and nothing is removed. The Plus-only screens are locked until you enter a licence in <b>Riyeser Central → Licence</b>. You\'ll see a message saying <b>Licence needed</b>.</p>'],
        ] },
        { title: 'Banking', items: [
          ['reconcile', 'Reconcile my bank account', '<ol><li>Click <b>Banking → Reconcile accounts</b> and choose the account.</li><li>Type the closing balance from your bank statement.</li><li>Tick each transaction that appears on the statement until the difference is <b>$0.00</b>.</li></ol>' + tip('Won\'t balance? Look for a missing or doubled transaction, or one dated after the statement date.'), true],
          ['import', 'Import a bank statement', '<p>Click <b>Banking → Bank statement import</b>, load the CSV file from your bank, then choose an account for each line in one click.</p>'],
          ['transfer', 'Move money between accounts or bank the till cash', '<p>Use <b>Banking → Transfer money</b>. For shop takings, transfer from <b>Undeposited Funds</b> (your cash drawer) to your bank account when you bank the cash.</p>'],
          ['bills', 'Enter and pay bills', '<p><b>Purchases → Enter bill</b> to record what you owe a supplier; <b>Purchases → Pay bills</b> when you pay it.</p>'],
        ] },
        { title: 'Payroll in Accounting', items: [
          ['payroll-import', 'Bring in pay runs from Riyeser Payroll', '<p>Finished pay runs from Riyeser Payroll appear under <b>Banking → Import from Riyeser Payroll</b>. Import each one to record the wages, tax and employer contributions in your books.</p>', true],
          ['payroll-builtin', 'Pay staff inside Accounting Plus', `<p>Add employees under <b>Payroll → Employees &amp; pay runs</b>, then click <b>Payroll → Run payroll</b>.</p>${warn('Tax withheld is an estimate using Australian 2024-25 rates. Check it before you lodge.')}`],
        ] },
        { title: 'GST, BAS and reports', items: [
          ['bas', 'Get my BAS figures', '<p>Click <b>Reports → BAS / GST</b>. It shows G1, 1A, 1B, W1, W2 and the other BAS boxes for the dates you choose.</p>', true],
          ['reports', 'Balance sheet, trial balance and more', '<p>Click <b>Reports → All reports</b> for Profit &amp; loss, Balance sheet, Trial balance, aged receivables and payables, job profit and loss and more. Every report prints and exports to CSV.</p>'],
          ['lock', 'Stop changes to a finished period', '<p>In <b>Setup → Company &amp; default accounts</b>, set <b>Lock periods up to</b> to a date, for example after your BAS is lodged. Nobody can then enter anything on or before that date.</p>' + tip('“Period is locked” means the date is on or before the lock date. Change the date, or an administrator can move the lock date.')],
        ] },
        { title: 'Journals, jobs and budgets', items: [
          ['journal', 'Enter a general journal', '<p>Click <b>Accounts → General journal</b> for adjustments such as depreciation. The debits must equal the credits; the difference is shown under the lines.</p>'],
          ['search', 'Find any transaction', '<p>Use the search box at the top, or <b>Accounts → Search transactions</b>.</p>'],
          ['jobs', 'Track jobs and budgets', '<p>Set up jobs under <b>Setup → Jobs</b> and pick the job on invoice and bill lines to see each job\'s profit. Set monthly budgets under <b>Setup → Budgets</b> and compare them with your actual figures.</p>'],
          ['nothing-deleted', 'Can I delete a transaction?', '<p>Nothing is ever deleted. Corrections are made by voiding or reversing, so the audit trail stays complete. See <b>Setup → Audit trail</b>.</p>'],
        ] },
        { title: 'More than one company', items: [
          ['companies', 'Run several companies (groups, trusts or clients)', '<ol><li>Click <b>Companies</b> in the menu, then <b>+ Add company</b>. Each company has its own books and users.</li><li>Switch company from its name at the top of the screen.</li><li><b>Companies</b> also shows cash, money owed, bills and profit for every company and in total.</li></ol><p>Have a company file from another computer or a client? Use <b>Bring in an existing company file</b>. The original isn\'t changed. Your plan includes one company; extra companies are $10 a month each.</p>'],
          ['roles', 'Give each person the right access', '<p>Open <b>Setup → Users &amp; roles</b>. Choose <b>Hidden</b>, <b>View</b>, <b>Add &amp; edit</b> or <b>Full</b> for each area, or click a quick set: <b>Owner</b>, <b>Bookkeeper</b>, <b>Sales staff</b>, <b>Payroll officer</b> or <b>Read-only</b>. Hidden areas really are hidden: their menus, figures and reports don\'t appear.</p>'],
        ] },
      ],
    },
    {
      id: 'pos', blurb: 'The till: selling, payments, close till and setup.', app: 'pos', name: 'Riyeser POS', badge: ['trial', '90 days free'],
      intro: 'A touch-friendly till, as its own app. It opens the same company file as Riyeser Accounting, so every sale is an invoice and payment there, and stock, GST and reports update by themselves. Free for 90 days.',
      groups: [
        { title: 'Getting started', items: [
          ['open', 'Install and open the till', '<ol><li>Download <b>Riyeser POS</b> from the Downloads page, or click <b>Get more apps</b> in Riyeser Central.</li><li>Open <b>Riyeser POS</b> from the desktop, the Start menu or Riyeser Central (<b>Open the till</b>). It opens straight on the till.</li><li>First time? It asks you to create a company file, or opens the one Riyeser Accounting already uses.</li></ol>', true],
          ['free-sales', 'How long is POS free?', '<p>Riyeser POS is free for 90 days, with as many sales as you like. The days left show at the top of the screen, and the till reminds you in the last two weeks. After the trial, new sales wait until you enter a licence key in Riyeser Central; sales, receipts, close till, products and stock all keep working.</p>'],
          ['setup', 'Choose Retail or Restaurant', '<ol><li>Go to <b>Setup → POS setup</b> in Riyeser POS (you need Full access to Setup to save).</li><li>Pick <b>Retail</b> or <b>Restaurant</b>. Each starts with sensible switches: barcode scanning and returns for shops; tables, kitchen dockets and takeaway for cafes.</li><li>Turn any switch on or off, name your tills (for example Till 1, Bar), and click <b>Save</b>.</li></ol>'],
          ['products', 'Add products, photos and Favourites', '<ol><li>Open <b>Products → Products &amp; stock</b> and open (or add) a product.</li><li>Add a photo and tick <b>Show in POS Favourites</b> for your best sellers.</li><li>The item appears on the till under its category, with its price and stock.</li></ol>'],
        ] },
        { title: 'Selling', items: [
          ['sell', 'Ring up a sale', '<ol><li>Tap products, or type or scan in <b>Search or scan an item</b>.</li><li>Change quantities in <b>Current sale</b>; tap <b>Hold</b> to park a sale and come back to it.</li><li>Tap <b>Pay</b>, choose <b>Cash</b> (the keypad works out the change) or <b>Card</b>, and finish the sale.</li></ol>'],
          ['receipt', 'Print or reprint a receipt', '<p>After the sale, choose <b>Print receipt</b>. To reprint, open <b>Sales</b>, find the sale and click <b>Receipt</b>.</p>'],
          ['void', 'Void a sale', '<p>Open <b>Sales</b>, find the sale and click <b>Void</b>. You need Full access to Sales. Stock goes back and the takings are reversed; the sale stays in the audit trail, it is never deleted.</p>'],
        ] },
        { title: 'End of the day', items: [
          ['today', "See today's takings", '<p>Open <b>Sales</b> for today\'s takings, sales by hour and your best sellers.</p>'],
          ['close', 'Close the till', '<p>Tap <b>Close till</b>, count the notes and coins, and Riyeser POS shows if the drawer is over or short. Closing prints the Z-report and records the takings going to the bank.</p>'],
        ] },
      ],
    },
    {
      id: 'payroll', blurb: 'Staff, time clock, pay runs and payslips.', app: 'payroll', name: 'Riyeser Payroll',
      intro: 'Time clock, timesheets, pay runs, payslips, leave, wage reports and bank statement checks, all kept on your computer.',
      groups: [
        { title: 'Getting started', items: [
          ['first', 'Setting up Payroll the first time', '<ol><li>Open Riyeser Payroll. It shows <b>Welcome to Riyeser Payroll</b>.</li><li>Enter your <b>Company name</b>, <b>Your name</b>, a <b>Username</b> and a <b>Password</b> (at least 8 characters), then click <b>Create login</b>.</li><li>Open <b>Settings &amp; access</b> to check your pay rules.</li><li>Add your staff under <b>Staff</b>.</li></ol>', true],
          ['menu', 'Where is everything?', '<p>The menu on the left is in four parts: <b>Today</b> (Dashboard, Time clock), <b>People</b> (Timesheets, Staff), <b>Pay</b> (Payroll, Pay history, Import wage reports, Bank statements, My payslips) and <b>Admin</b> (Settings &amp; access, Audit trail, Login history, My account). People only see the parts they have access to.</p>'],
          ['rules', 'Check the pay rules before the first pay run', `<p>Open <b>Payroll → Payroll rules</b>. Check how often you pay, the day a pay period starts, the FNPF employee and employer percentages, unpaid break rules and any regular deductions. The PAYE tax brackets are in <b>Settings &amp; access → Payroll</b>.</p>${warn('Check the PAYE and FNPF rates against the current FRCS and FNPF rules before you pay staff.')}`],
        ] },
        { title: 'Staff', items: [
          ['add-staff', 'Add a staff member', '<ol><li>Open <b>Staff</b> and click <b>+ Staff member</b>.</li><li>Fill in their name, position, pay rate and bank details.</li><li>Set a <b>Time-clock PIN (4 digits)</b>, or leave it blank and one is made for them.</li><li>Save. Click <b>Access</b> next to their name to choose what they can see.</li></ol>', true],
          ['access', 'Choose what each person can see', '<p>Click <b>Access</b> next to a person. For each area pick <b>Hidden</b>, <b>View</b>, <b>Add &amp; edit</b> (no deleting) or <b>Full</b>, or choose a preset: <b>Owner</b>, <b>Payroll officer</b>, <b>Supervisor</b> (their own team, no pay rates or bank details), <b>Employee self-service</b> (their own timesheets and payslips) or <b>Read-only</b>.</p>'],
          ['password', 'Change or reset a password', '<p>Change your own under <b>My account → Change password</b>. If a staff member forgets theirs, an administrator opens them in <b>Staff</b> and types a new one in <b>Reset password</b>.</p>'],
        ] },
        { title: 'Time clock and timesheets', items: [
          ['clock', 'Clock in and out', '<ol><li>Open <b>Time clock</b> on the shared office PC.</li><li>Tap your name.</li><li>Type your 4-digit PIN. You\'re clocked in (or out).</li></ol><p>Hours go straight into Timesheets and the pay run.</p>', true],
          ['timesheets', 'Check and fix timesheets', '<p>Open <b>Timesheets</b>. Shifts that look wrong are flagged, for example <b>still clocked in</b> or <b>over 12 h — forgot to clock out?</b> Click a shift to fix it, or use <b>🗓 Multi-shift</b> to enter several at once.</p>' + tip('On a shared PC, someone with timesheet access can type their PIN to unlock editing for 15 minutes. Changes are recorded as done by them.')],
          ['leave', 'Record leave and see balances', '<p>On <b>Timesheets</b>, click <b>🌴 Accruals</b> to see each person\'s annual and sick leave taken and left. Open a person to <b>Add leave taken</b>, then click <b>Save leave</b>.</p>'],
        ] },
        { title: 'Pay runs and payslips', items: [
          ['pay-run', 'Do a pay run', '<ol><li>Open <b>Payroll</b>.</li><li>Under <b>New pay run</b>, check the dates and click <b>Preview</b>. You\'ll see hours, gross pay, FNPF, PAYE, other deductions and net pay for each person.</li><li>Fix anything that looks wrong in Timesheets, then preview again.</li><li>Click <b>Finalise pay run</b>.</li></ol>', true],
          ['payslips', 'Print, save or email payslips', '<p>After a pay run, click <b>Payslip</b> next to a person, or <b>Print all payslips</b>. To save PDFs, use <b>Export payslips</b>: one PDF for each payslip, or all in one. They\'re saved in <code>Documents\\Riyeser\\Payroll\\Payslips</code> (menu <b>Payroll → Open the payslips folder</b>).</p>', true],
          ['my-payslips', 'Staff seeing their own payslips', '<p>Everyone can open <b>My payslips</b> to see and print their own payslips.</p>'],
          ['history', 'Look at past pay runs', '<p>Open <b>Pay history</b>, or see <b>Past pay runs</b> on the Payroll page.</p>'],
          ['blank-payslip', 'A payslip PDF looks blank', `<p>Make sure Payroll is up to date (Riyeser Central → <b>Update</b>), then export the payslip again. If it still looks blank, email <a class="more" href="mailto:${EMAIL}">${EMAIL}</a> with the pay date (not the payslip).</p>`],
        ] },
        { title: 'Wage reports and bank statements', items: [
          ['import-wages', 'Bring in monthly Excel wage reports', '<ol><li>Open <b>Import wage reports</b> and choose the Excel files (one sheet per person, a row per week). You can choose several months at once.</li><li>Click <b>Check files</b>. For each sheet, choose who it is: a new staff member or someone already on Staff.</li><li>Click <b>Import</b>. Nothing is saved until you do.</li></ol>'],
          ['bank', 'Check wages against the bank statement', '<ol><li>Open <b>Bank statements</b> and choose your statement (PDF, CSV or Excel), or paste the statement lines.</li><li>Click <b>Find wage payments</b>.</li><li>Choose who each payment was for, or <b>Not wages</b>, then click <b>Save wage payments</b>.</li></ol><p>The payments then show next to each person\'s pay history.</p>'],
        ] },
        { title: 'Backups and email', items: [
          ['backup', 'Are my payroll records backed up?', '<p>Yes. Payroll makes a backup copy every day in <code>Documents\\Riyeser\\Payroll\\Backups</code> and keeps the last 30. You can also choose <b>Payroll → Back up now</b> (<kbd>Ctrl</kbd>+<kbd>B</kbd>).</p>' + tip('Copy the Backups folder to a USB stick or cloud drive now and then, in case this computer is lost or breaks.'), true],
          ['restore', 'Bring back a backup', '<p>Choose <b>Payroll → Restore from a backup…</b> and pick the backup file.</p>'],
          ['where', 'Where are my records kept?', '<p>On this computer only. Choose <b>Help → Where are my records?</b> in Payroll to see the exact folder.</p>'],
          ['email', 'Email payslips and timesheets', '<p>In <b>Settings &amp; access</b>, fill in your email details (the <b>Email host (SMTP)</b>, port and the address to send from), then click <b>Send test email</b> to check it works.</p>'],
        ] },
      ],
    },
    {
      id: 'desk-assistant', blurb: 'Find, sort and tidy your files.', app: 'desk-assistant', name: 'Riyeser Desk Assistant',
      intro: 'Sorts your files by type and year, finds anything in seconds, spots duplicate copies, and keeps your meetings and to-dos.',
      groups: [
        { title: 'Getting started', items: [
          ['setup', 'First-time setup (about 2 minutes)', '<ol><li>Open <b>🏢 Companies</b> and type your own business name, so your own invoices aren\'t filed under you. Add the companies you deal with.</li><li>Open <b>⚙ Settings → Calendars</b> and connect your calendar (see below).</li><li>Check <b>📁 Folders</b>: Downloads and Desktop are watched for new files. Add your phone\'s synced photo or scan folder if you use one.</li></ol>', true],
          ['tray', 'Is it still running when I close it?', '<p>Yes. Desk Assistant keeps running in the system tray (by the clock) so it can remind you about meetings and keep its search up to date. Right-click the tray icon to quit.</p>'],
        ] },
        { title: 'Finding files', items: [
          ['find', 'Find a file', '<p>Click <b>🔍 Find a file</b> and type any part of the file\'s name, a word inside it, a company, or a name it used to have. Narrow it down by type, year or kind of file.</p>' + tip('Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> anywhere in Windows to open a quick search box.'), true],
          ['where', 'Desk Assistant moved a file. Where is it?', '<p>Open <b>↩ Where are my files?</b>. Every file it has moved or renamed is listed with where it used to be and where it is now. Search by the old or new name and click <b>Open</b>.</p>', true],
        ] },
        { title: 'Tidying up', items: [
          ['sort', 'Sort my files by type and year', '<ol><li>Click <b>🗂 Sort by type</b>.</li><li>Choose the folders to sort. It puts every file into <b>Organised › Type › Year</b>, for example <b>Invoices › 2026</b> or <b>Drawings › 2026</b>.</li><li>Check the preview. Untick anything you want left where it is.</li><li>Click to move them. You can undo it afterwards.</li></ol>', true],
          ['undo', 'Undo a tidy-up', '<p>On <b>🏠 Today</b>, under <b>Recent tidy-ups</b>, click <b>Undo</b>. Or open <b>↩ Where are my files?</b> and click <b>Put everything back</b> to return every file to where it was.</p>'],
          ['duplicates', 'Find duplicate copies', '<p>Sort by type and Smart review both find copies, even when one is a Word file and the other is a PDF. Extras are moved to <b>Archive › Duplicates</b>, not deleted, and that can be undone too.</p>'],
          ['unsure', 'What is “Needs your help”?', '<p>Files Desk Assistant couldn\'t place with confidence. Open one to check, or add the company under <b>🏢 Companies</b> and scan again. They stay where they are until you decide.</p>'],
          ['safe', 'What will it never touch?', '<p>Windows and program folders, folders programs rely on (Outlook data, accounting files, OneNote and so on), code projects, shortcuts and system files. Only your own documents are sorted.</p>'],
        ] },
        { title: 'Meetings, to-dos and email', items: [
          ['calendar', 'Connect my calendar', '<p>Open <b>⚙ Settings → Calendars</b> and paste your calendar\'s secret iCal address:</p><ul><li><b>Google Calendar</b>: Settings → your calendar → <b>Secret address in iCal format</b>.</li><li><b>Outlook</b>: Settings → Calendar → Shared calendars → <b>Publish a calendar</b> → ICS link.</li></ul><p>Or import an .ics file. Your meetings then show on <b>📅 Meetings</b> and in Riyeser Central.</p>', true],
          ['todo', 'Where do to-dos come from?', '<p>From meeting agendas, meeting notes and emails (lines marked <code>[ ]</code>, <code>Action:</code> or <code>TODO:</code>), plus anything you add yourself on <b>✅ To-do</b>.</p>'],
          ['email', 'Sort my email (optional)', '<p>Open <b>✉ Email</b> and connect any IMAP mailbox using an “app password” from your email account\'s security settings. It sorts your latest emails, flags ones that need a reply, and can save invoice attachments to the right company folder. It is read-only: nothing in your mailbox is moved or deleted.</p>'],
        ] },
        { title: 'Privacy and removing it', items: [
          ['privacy', 'Does it send my files anywhere?', '<p>No. Everything stays on this computer. If you choose to add an AI key in Settings, files it\'s unsure about are sent to Claude to identify (the first ~4,000 characters only). Leave it blank to stay fully offline.</p>'],
          ['remove', 'Remove Desk Assistant', '<p>Use <b>⚙ Settings</b> → remove, or Windows <b>Settings → Apps</b>. Your own files, including everything in your Organised folder, are kept.</p>'],
        ] },
      ],
    },
    {
      id: 'pdf', blurb: 'Fill in, sign, mark up and combine PDFs.', app: 'pdf', name: 'Riyeser PDF',
      intro: 'Open, fill in, sign, mark up, combine and edit PDFs, even scanned ones. Every save keeps a backup of the previous version.',
      groups: [
        { title: 'Getting started', items: [
          ['default', 'Make Riyeser PDF open my PDFs', '<p>Click <b>Set as PDF app</b> at the top, or right-click any PDF → <b>Open with → Choose another app</b> → <b>Riyeser PDF</b> → <b>Always</b>. Windows may ask you to confirm in Settings → Default apps.</p>', true],
          ['open', 'Open and save', '<p>Click <b>Open</b> and choose the PDF. <b>Save</b> writes your changes back; <b>Save as…</b> makes a new copy. The word <b>unsaved</b> shows when you have changes. <b>↶</b> and <b>↷</b> undo and redo.</p>'],
          ['backup', 'I saved over something by mistake', '<p>Every time you save, the previous version is backed up automatically (the last 100 are kept). In Desk Assistant\'s <b>📕 PDF editor</b> page, click <b>Open backups folder</b>.</p>'],
        ] },
        { title: 'Filling in and signing', items: [
          ['fill', 'Fill in a form', '<p>Click the <b>Form</b> tab on the side panel to fill in a PDF form\'s boxes. For forms without boxes, use <b>T Add text</b> and click where you want to type. <b>✓ Tick</b>, <b>✗ Cross</b> and <b>📅 Date</b> add those in one click.</p>', true],
          ['sign', 'Sign a PDF', '<ol><li>Click <b>✍ Sign</b>.</li><li>Choose <b>Draw</b> (use your mouse, trackpad or touch screen), <b>Type</b> (pick a style), or <b>Upload image</b> (a photo of your signature on white paper).</li><li>Tick <b>Remember this signature</b> to use it again, then click <b>Place signature</b> and click where it goes.</li></ol>', true],
        ] },
        { title: 'Editing and marking up', items: [
          ['edit-text', 'Change the words in a PDF', '<p>Click <b>✎ Edit text</b>, then click the words you want to change. For big changes, use <b>🧰 Tools → Convert to Word</b> to edit the whole document in Word.</p>'],
          ['markup', 'Mark up a drawing', '<p>Use <b>▮ Highlight</b>, <b>U̲ Underline</b>, <b>S̶ Strike</b>, <b>✐ Draw</b>, <b>▭ Box</b>, <b>◯ Circle</b>, <b>╱ Line</b>, <b>➚ Arrow</b> and <b>🔖 Stamp</b>. Click <b>↖ Select</b> to move or change something you\'ve added.</p>'],
          ['hide', 'Hide or black out information', '<p><b>◻ White-out</b> covers something with white. <b>■ Redact</b> blacks it out for good, for example bank details or tax file numbers.</p>'],
        ] },
        { title: 'Pages', items: [
          ['combine', 'Combine PDFs into one', '<p>Open the first PDF, click the <b>Pages</b> tab, then <b>+ Insert PDF</b> and choose the others. Drag pages into order and save.</p>', true],
          ['pages', 'Rotate, move, delete or take out pages', '<p>On the <b>Pages</b> tab, select a page (<kbd>Ctrl</kbd>+click for several), then use <b>⟲ ⟳</b> to rotate, <b>▲ ▼</b> to move, <b>🗑</b> to delete, or <b>Extract</b> to save them as a new PDF. <b>🧰 Tools</b> also has <b>Insert blank page</b>, <b>Split into separate files</b> and <b>Page numbers…</b></p>'],
        ] },
        { title: 'Scans and converting', items: [
          ['ocr', 'I can\'t select or search the words in a scan', '<p>When a PDF is a scan you\'ll see <b>📷 This looks like a scanned document</b>. Click <b>🔍 Recognise text</b>. The words can then be searched, copied and edited.</p>', true],
          ['convert', 'Make a PDF from pictures, Word or Excel', '<p>Click <b>🧰 Tools → Create PDF from pictures, Word, Excel…</b>. If Microsoft Office is installed it\'s used for an exact match.</p>'],
          ['compress', 'The PDF is too big to email', '<p>Click <b>🧰 Tools → Make smaller (compress)…</b>. Pages are turned into pictures at a lower quality, which is great for scans and photos. Run <b>Recognise text</b> again afterwards if you need to search it.</p>'],
        ] },
        { title: 'Something\'s not right', items: [
          ['blank', 'A PDF opens blank or grey', '<p>Click <b>🧰 Tools → Open in basic viewer</b>. It shows any PDF using Windows\' own viewer, so you can still read and print it.</p>', true],
        ] },
      ],
    },
    {
      id: 'services', blurb: 'Projects, drawings, inspections and sign in.', app: 'services', name: 'As Built',
      intro: 'Building services on your drawings: cables, pipes and ducts with inspections, tests and photos. Works in a browser, or as a Windows app on your PC.',
      groups: [
        { title: 'Getting started', items: [
          ['how', 'On this PC or with an online account?', '<p>The Windows app asks the first time you open it.</p><ul><li><b>On this PC</b>: no account, projects saved on your computer, works with no internet.</li><li><b>With my online account</b>: sign in and your projects sync with phones, the website and your team.</li></ul><p>Change it any time from the <b>As Built</b> menu → <b>How I work…</b></p>', true],
          ['project', 'Start a project', '<ol><li>Tap <b>New project</b> and give it a name, site and client.</li><li>Tap <b>Upload drawings</b> and choose your PDFs or images. Tap each page you want so it has a green tick, then tap <b>Add</b>. Each one becomes a level.</li><li>Tap <b>Set scale</b>, tap two points a known distance apart and type the distance. Lengths are then measured for you.</li></ol>', true],
          ['demo', 'Try it first', `<p>Open the <a class="more" href="${SERVICES_APP}/?demo">demo</a> to explore a marked-up resort with a guided tour. Nothing is saved.</p>`],
        ] },
        { title: 'On the drawing', items: [
          ['items', 'Add an outlet, board or pit', '<ol><li>Tap <b>Add item</b>, choose the trade, then the item.</li><li>Tap the drawing where it goes.</li><li>Fill in the details and tap <b>Save</b>. <b>Add another like this</b> places a row of the same item quickly.</li></ol>'],
          ['runs', 'Draw a cable, pipe or duct', '<p>Tap <b>Draw a run</b>, choose what it is, then tap along the route. Start and finish on items such as a rack, pit or outlet so it\'s connected at both ends.</p>'],
          ['inspect', 'Inspections, tests and photos', '<p>Open an item and tap <b>Inspect</b>. Mark each check Pass, Fail or N/A, record test readings and add photos before the wall or trench is closed. <b>To do</b> shows everything still outstanding.</p>'],
        ] },
        { title: 'Online account and handover', items: [
          ['sync', 'Move my PC projects online', '<p>Choose the <b>As Built</b> menu → <b>Sync to my online account…</b> and sign in. Your projects and photos upload, and the copy on the PC is kept as a backup.</p>'],
          ['password', 'I forgot my online password', '<p>On the sign-in screen choose <b>Forgot password</b> and follow the email. Projects saved on your PC are not affected.</p>'],
          ['offline', 'Working without signal on site', '<p>Keep working. Changes are saved on the device and sync when you\'re back online. The status at the top shows <b>All saved</b> or how many changes are waiting.</p>'],
          ['full', 'The full As Built guide', `<p>For drawings, markup, ports and racks, RFIs, defects, schematics and reports, see the <a class="more" href="${SERVICES_APP}/help.html">complete As Built guide</a>, or tap <b>?</b> in the app for help on the screen you\'re on.</p>`, true],
        ] },
      ],
    },
  ];
}
