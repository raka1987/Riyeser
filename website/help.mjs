// Help Centre text: one guide per program, written from what each program's screens and menus actually say.
// Button and menu names are in <b>bold</b> exactly as they appear in the program. Keep answers short and plain.
// Each guide: { id, name, intro, groups: [{ title, items: [[anchor, question, answerHtml, popular?]] }] }.
// Prices come from prices.mjs (US dollars, per business per month).
import { PRICE, STORAGE_GB, BUNDLES, usd } from './prices.mjs';

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
          ['trial', 'How does the free trial work?', `<p>Riyeser Central, Desk Assistant, Riyeser Invoices and PDF are free forever. Every paid program — <b>Accounting Basics</b>, Accounting Plus, Bookings, Riyeser Link, Payroll and <b>Riyeser POS</b> — is free for 90 days. No card and no sign-up. Each program shows how many days are left.</p><p>When the trial ends nothing is deleted and nothing is charged. Only new invoices (Basics), new till sales (POS) or the screens of the other programs wait until you enter a licence key in Riyeser Central.</p><p>After that, each program is one price per business per month, in US dollars, with 3 users included: Accounting Basics ${usd(PRICE.basic)}, Accounting Plus ${usd(PRICE.plus)} (it includes Basics), Bookings ${usd(PRICE.bookings)}, Riyeser Link ${usd(PRICE.calls)}, Payroll ${usd(PRICE.payroll)} (unlimited employees) and POS ${usd(PRICE.pos)} (1 till, unlimited cashiers). Each extra user is ${usd(PRICE.extra_user)} a month for that program, each extra till ${usd(PRICE.extra_till)}, and your accountant signs in free. Bundles cost less: ${BUNDLES.map((b) => `${b.name} ${usd(b.price)}`).join(', ')}. Pay yearly and get 2 months free. See <a class="more" href="${up}pricing.html">Pricing</a>.</p>`, true],
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
          ['more', 'I need stock, bills or a Profit &amp; Loss', `<p>Install <b>Accounting Basics</b>. It opens the same company file, so every customer, invoice and payment is already there. It's free for 90 days, then ${usd(PRICE.basic)} a month per business, with 3 users included. Click <b>Setup → Need stock or bills?</b> in Riyeser Invoices for the download.</p>`],
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
      id: 'link', blurb: 'Chat, calls and desk phones: channels, direct messages, extensions.', app: 'link', name: 'Riyeser Link',
      intro: 'Chat and calls for your business (it used to be called Riyeser Team), online so everyone can use it on the PC (the Riyeser Link app, or Riyeser Link in Riyeser Central) or a phone (riyeser.com/link). Each business only sees its own team.',
      groups: [
        { title: 'Getting started', items: [
          ['layout', 'Find your way around', '<p>Riyeser Link keeps it simple: <b>one list and one chat</b>.</p><ul><li><b>On a PC</b>: along the top are your business name, <b>Search chats and people</b>, <b>Calls</b>, <b>People</b>, your status and your picture. Below, on the left, is one list with your channels and the people you message, newest first (pinned chats stay at the top). Use <b>All</b>, <b>Channels</b>, <b>People</b> or <b>Unread</b> to narrow it, and <b>+ New</b> to start a chat. The chat you open fills the rest.</li><li>In a chat, the green <b>Call</b> button calls (and opens the keypad if you need it), <b>ⓘ</b> opens the details (who\'s in it, files, pin, mute, channel settings) and <b>⋯</b> has the channel menu.</li><li><b>On a phone</b>: <b>Chats</b>, <b>Calls</b>, <b>People</b> and <b>Settings</b> are along the bottom. Tap a chat to open it full screen, and the back arrow to go back. Tap <b>+</b> for a new chat.</li><li>Tap <b>your picture</b> for your status, <b>My phone and devices</b>, <b>Settings</b>, <b>Help</b> and <b>Sign out</b> (owners and admins also see <b>Management</b>).</li></ul>', true],
          ['status', 'Your status: Available, Busy, At lunch, Away, Unavailable', '<p>Tap your picture (or your status at the top) and choose:</p><ul><li><b>Available</b> (green).</li><li><b>Busy · Do not disturb</b> (red): calls don\'t ring you, and messages arrive quietly.</li><li><b>At lunch</b> 🍽: calls don\'t ring you.</li><li><b>Away</b> (yellow): calls still ring. It also comes on by itself after 10 minutes without using Riyeser Link.</li><li><b>Unavailable</b> (grey): calls don\'t ring you.</li></ul><p>Under <b>For how long?</b> choose <b>30 min</b>, <b>1 hour</b> or <b>Until</b> a time, and it goes back to Available by itself. Someone who calls you while you\'re Busy, At lunch or Unavailable is told you can\'t take calls right now, so they can send a message instead. Your desk phone follows too (Do not disturb).</p><p><b>On a call</b> shows by itself while you\'re on a call in Riyeser Link or on your desk phone, then goes back to what you had. <b>Offline</b> shows when Riyeser Link isn\'t open. You can\'t choose these two.</p>', true],
          ['management', 'Management (owners and admins)', '<p>Everything about the business is in <b>Management</b>: <b>People &amp; access</b>, <b>Join requests</b>, <b>Company</b>, <b>Branches &amp; extensions</b>, <b>Desk phones</b>, <b>Security</b>, <b>History</b> and (the owner) <b>Billing &amp; plan</b>. Tap your picture, then <b>Management</b>. Staff never see it.</p><p>Management is <b>locked</b>: each time you open it, type the 6 numbers from your authenticator app. It locks again after <b>15 minutes</b> without use, when you sign out or reload, or when you press <b>Lock now</b>. If you haven\'t turned on two-step sign-in yet, Management only shows the step to turn it on.</p><p><b>Admin</b> is for the owner and IT staff. Only the owner can make someone an admin or take it away.</p>', true],
          ['start', 'Set up your company', '<ol><li>Install <b>Riyeser Link</b> for Windows (Downloads, or Get more apps in Riyeser Central), or open <b>riyeser.com/link</b> on any device.</li><li>Click <b>Create an account</b> with your work email and a password, and confirm your email from the link we send.</li><li>Sign in, open <b>Set up a new company</b>, and enter the business name, ABN/TIN and country.</li><li>You get your <b>Company ID</b>, like <b>RIY-7K3M-Q2</b>. Everyone in the company, on every Riyeser program and PC, links with it.</li></ol>', true],
          ['invite', 'Add your staff (like accepting a friend request)', '<ol><li>Give staff the <b>Company ID</b>, or their branch\'s code (for example <b>LAU-4821</b>), or open <b>Settings → Invite people</b> and send the link.</li><li>They create a free account and click <b>Ask to join</b>. They wait on a screen that lets them in by itself once you approve.</li><li>You see them under <b>Management → Join requests</b> (the number shows next to Management when you tap your picture). Choose their <b>job role</b> (Manager, Bookkeeper, Sales, Payroll, Staff or Read-only) and their <b>branches</b>, then click <b>Approve</b>. Only the owner can also make someone an <b>admin</b>.</li></ol><p>To change what someone can do later, open <b>Management → People &amp; access</b>. Changes apply straight away on all their devices. <b>Remove from company</b> takes away their access everywhere; their old messages stay.</p>', true],
          ['twostep', 'Two-step sign-in (owners and admins must)', '<p>Two-step sign-in means signing in needs your password <b>and</b> a 6-number code from an authenticator app on your phone, so a stolen password isn\'t enough. Owners and admins must turn it on before they can open Management (approve people, change access, see the history); everyone else can too.</p><ol><li>Install <b>Microsoft Authenticator</b> or <b>Google Authenticator</b> on your phone (free).</li><li>In Riyeser Link open <b>Settings → Sign-in and security → Turn on</b>, scan the code with the app, and type the 6 numbers it shows.</li><li>Next time you sign in, type the code from the app after your password.</li></ol><p>New phone? Turn it off on the old phone first, or ask Riyeser support to reset it.</p>', true],
          ['history', 'See who changed what', '<p>Owners and admins: open <b>Management → History</b> to see who approved people, changed access, added branches, linked or unlinked PCs and changed the company details, and when. Nobody can edit or delete it.</p>'],
          ['company', 'Company details and linked PCs', '<p>Your Company ID is in <b>Settings → Company</b>. Owners and admins open <b>Management → Company</b> to update the business details, and see every <b>linked PC</b> and can <b>Unlink</b> one (for example a lost laptop). Nothing is deleted.</p>'],
        ] },
        { title: 'Chatting', items: [
          ['private', 'Make a private chat (executives, sales, managers)', '<ol><li>Click <b>+ New</b> (on a phone, the <b>+</b> button), then <b>New channel instead</b>.</li><li>Give it a name, for example <b>executives</b> or <b>sales</b>.</li><li>Leave <b>Only people I choose</b> ticked (it\'s the default) and tick the people who should be in it.</li><li>Click <b>Add</b>.</li></ol><p>A private chat shows a 🔒. It doesn\'t show up at all for anyone who isn\'t in it, so nobody else even knows it\'s there. To change who\'s in it later, open it, click <b>ⓘ</b> and then <b>Change who\'s in it</b>: whoever made it, or a team owner or admin, can tick or untick people. Anyone in it can click <b>Leave this chat</b>.</p>', true],
          ['dm', 'Send a private message', '<p>Click a person in your list (choose <b>People</b> at the top of the list to see only people), or click <b>+ New</b> and pick them. Only the two of you can read it.</p>'],
          ['refs', 'Point at an invoice or job', '<p>Type the number the way Riyeser shows it, for example <b>INV-1047</b>, <b>Q-0042</b> or <b>Booking 12</b>, and it stands out in the message. Type <b>@</b> and a name to get someone\'s attention.</p>'],
          ['edit', 'Change or delete a message', '<p>Point at your message (or tap it on a phone) and click <b>Edit</b> or <b>Delete</b>. Edited messages say “(edited)”.</p>'],
        ] },
        { title: '📞 Calls, branches and extensions', items: [
          ['calls-setup', 'Set up branches and extensions', '<ol><li>When you start a team you get <b>Head office</b> on <b>100</b>, and you\'re on <b>101</b>.</li><li>Open <b>Management → Branches &amp; extensions</b> (owners and admins), type a branch name such as <b>Lautoka branch</b> and click <b>+ Add branch</b>. It gets the next number (200, 300…) and its own join code, like <b>LAU-4821</b>.</li><li>Give each branch\'s staff their branch code. When they join with it they go straight into that branch with the next extension (201, 202…).</li><li>To change someone\'s number, type it under <b>Extensions</b> and click <b>Save extensions</b>.</li></ol><p>There\'s nothing to set up on the devices: whatever PC or phone someone is signed in on is their extension. A shared front-desk PC can sign in as, for example, “Lautoka front desk”.</p>', true],
          ['calls-make', 'Make a call', '<p>Open someone\'s chat and click the green <b>Call</b> button, then <b>Voice call</b> or <b>Video call</b> (in a channel, choose who to call). <b>Keypad</b> in the same menu dials an extension. Or open <b>Calls</b> to see your recent calls, ring a branch (everyone there rings; the first to answer takes it), or use the keypad. While you\'re on a call, a slim bar across the top shows who it\'s with and how long, with <b>Mute</b>, <b>Hold</b>, <b>Audio</b>, <b>Camera</b> and <b>End</b>; the chat stays free underneath. A note like “📞 Call · 3:12” or “📞 Missed call” is left in your messages.</p>', true],
          ['calls-ring', 'Make sure calls ring', '<p>Calls ring wherever Riyeser Link is open. On a PC, install the <b>Riyeser Link</b> app (it starts with Windows), or open <b>Riyeser Link</b> in Riyeser Central once: after that it keeps running in the background while Central is open, and pops up when someone calls. On a phone, keep riyeser.com/link open. The first time, allow the microphone when asked.</p>'],
          ['calls-price', 'What does Riyeser Link cost?', `<p>Riyeser Link (chat, calls, branches and extensions, Riyeser Link Office for desk phones, and ${STORAGE_GB.link} GB of space for files shared in chat) is <b>${usd(PRICE.calls)} a month per business</b>, with 3 users included (then ${usd(PRICE.extra_user)} a month for each extra person who chats or takes calls; your accountant is free), free for your team's first 90 days. It's also in the Shop, Office and Business bundles. There are no call charges: calls go over your internet.</p><p>If Riyeser Link isn't paid after the free days, nothing is deleted: everyone can still read the chats, and sending new messages waits until the owner adds Riyeser Link on the Riyeser home page (<b>Add to my plan</b>).</p>`],
        ] },
        { title: '☎ Desk phones (Riyeser Link Office)', items: [
          ['desk-phones', 'Setting up desk phones', `<p><b>Riyeser Link Office</b> is your office phone system. It runs on one PC at the office, and your desk phones connect to it and call each other. It comes with Riyeser Link.</p><ol><li>Install <b>Riyeser Link Office</b> on a PC at the office that stays on (<a class="more" href="${up}programs/link-office.html">download it here</a>, or <b>Riyeser Central → Get more apps</b>). Set the PC never to sleep while plugged in.</li><li>Open it and sign in with your Riyeser account. It brings in your people, extensions and branches.</li><li>Plug the desk phones into the same office network as that PC and turn them on. Many desk phones don't come with a power adapter and expect power over the network cable (PoE): buy the phone's power adapter, or a small PoE switch.</li><li>Yealink, Grandstream, Snom and Polycom phones show up as <b>New phone found</b>. Click <b>Give to…</b> and choose who it's for. The phone sets itself up within a minute (restart it if not).</li><li>Another kind of phone, or a SIP app such as Linphone or Zoiper? Use <b>Set up a phone by hand</b> next to the person and type in the <b>Server address</b>, <b>Port</b>, <b>Username</b> and <b>Password</b> it shows.</li></ol>${tip('Ask your router to always give the Riyeser Link Office PC the same address (a <b>DHCP reservation</b> or <b>static lease</b>). Otherwise phones can lose touch when the address changes.')}${warn('These phones can only call each other. They can\'t call emergency services: keep a mobile or normal phone line for that.')}`, true],
          ['own-desk-phone', 'Set up your own desk phone', `<p>Everyone can see their own phone details: in Riyeser Link tap your picture and choose <b>My phone and devices</b> (or <b>Settings → My phone</b>, or the <b>My phone</b> tile on your Riyeser home page). It shows your extension: others call you by dialling it.</p><ol><li>Plug the phone into a network socket at the office (and into power, if it has an adapter).</li><li>Most phones set themselves up: your manager will see it appear and give it to you.</li><li>If it doesn't, type these into the phone's account settings: the <b>Server address</b> and <b>Port</b> 5060 shown on My phone, your extension as the <b>Username / Account</b>, and your <b>Password</b> (click <b>Show</b>, then <b>Copy</b>).</li><li>Test it: dial another extension, for example 100 for Head office.</li></ol><p><b>Where do I type these on my phone?</b> Every desk phone has a settings web page: type the phone's IP address into a web browser, sign in, then look for <b>Account</b> (or <b>Line</b>) → <b>Register</b>. Menus differ by model. My phone has short notes for Yealink, Grandstream, Snom and Polycom.</p><p><b>Where's the label?</b> Turn the phone over. The label shows the <b>MAC</b> address (12 letters and numbers) and <b>S/N</b> (serial number). Plug the network cable into the <b>LAN</b> port, not the PC port.</p><img class="helpimg" src="${up}assets/help/phone-label.webp" alt="The label under a desk phone showing MAC and S/N, above the LAN port" loading="lazy" width="700" height="394">${tip('On My phone you can also turn <b>Do not disturb</b> on or off, and <b>Report a phone issue</b> with your phone\'s details already filled in.')}${warn('These phones can\'t call emergency services. Keep a mobile or normal phone line for that.')}`, true],
          ['add-desk-phone', 'Add, replace or fix a desk phone (owners and admins)', '<p>Open <b>Management → Desk phones</b> in Riyeser Link. The 5 steps at the top tick themselves off as you go. Click <b>+ Add desk phone</b>: name the phone (like Reception), choose its location and extension, pick it from the new phones found or type the MAC from its label, then plug it in. Its status moves from <b>Waiting for phone</b> to <b>Configuring</b> to <b>Online</b>. Then make a test call.</p><p>Click <b>⋯</b> next to a phone for <b>View setup</b>, <b>Troubleshoot</b> (power, cable in the LAN port, same office network, the office PC on), <b>Replace phone</b> (the new one keeps the extension, name and location), <b>Advanced setup (manual SIP)</b> and <b>Rename / move location</b>.</p>'],
          ['phones-page', 'See and manage the phones from the website', '<p>Owners and admins: on your Riyeser home page click <b>☎ Phones</b> (or <b>Management → Desk phones</b> in Riyeser Link; both ask for your two-step code first). You see whether Riyeser Link Office is running, the <b>server address to type into phones</b>, every extension and desk phone (● connected, ○ not), and new phones found. You can give a phone to someone, add one by its MAC address (on a sticker under the phone), remove it from a person, turn <b>Do not disturb</b> on or off, and make a new password. Each change says <b>Sending to Riyeser Link Office…</b>, then <b>Done</b>: the office PC checks for changes every 30 seconds while it\'s on. You need two-step sign-in to make changes.</p>'],
          ['phone-password', 'Where is a phone\'s password?', '<p>Each extension\'s password is made and kept on the Riyeser Link Office PC, never online. In <b>Set up a phone by hand</b>, click <b>Show</b>: the office PC sends it to your screen only, encrypted so nobody else can read it on the way, and it\'s gone when you close the box. Every <b>Show</b> is in your <b>🕘 History</b>. <b>Make a new password</b> stops phones using the old one until they get the new one; desk phones set up by Riyeser Link Office get it when they restart.</p>'],
          ['let-riyeser-help', 'Let Riyeser support help with the phones', '<p>On the Phones page click <b>Let Riyeser help</b>. For the next hour Riyeser support can see your phone set-up and make the same changes you can, including showing a phone\'s password while they help you set it up. Everything they do is in your <b>🕘 History</b>. Click <b>End it now</b> to stop it early.</p>'],
        ] },
      ],
    },
    {
      id: 'link-office', blurb: 'Your office phone system: desk phones, extensions and ring groups.', app: 'link-office', name: 'Riyeser Link Office',
      intro: 'Your business\'s phone lines: the office phone system. Install it on one Windows PC at the office that stays on, plug in desk phones, and everyone gets an extension. It comes with Riyeser Link.',
      groups: [
        { title: 'Getting started', items: [
          ['install', 'Install Riyeser Link Office', `<ol><li>On a Windows PC at the office that stays on, download <b>Riyeser Link Office</b> from the <a class="more" href="${up}downloads.html">Downloads</a> page, or click <b>Get more apps</b> in Riyeser Central.</li><li>Open it and sign in with your Riyeser account. It brings in your people, extensions and branches.</li><li>Set the PC never to sleep while plugged in.</li></ol>${tip('Ask your router to always give this PC the same address (a <b>DHCP reservation</b> or <b>static lease</b>). Otherwise phones can lose touch when the address changes.')}`],
          ['link-plus', 'Do I need Riyeser Link?', `<p>Yes. Riyeser Link Office comes with <a class="more" href="${up}pricing.html#link">Riyeser Link</a> (${usd(PRICE.calls)} a month, free for 90 days): there's no separate price. The program is free to download, and it switches on when your business has Riyeser Link.</p>`],
        ] },
        { title: 'Desk phones', items: [
          ['phones', 'Plug in desk phones', `<ol><li>Plug the desk phones into the same office network as the Riyeser Link Office PC and turn them on. Many desk phones expect power over the network cable (PoE): buy the phone's power adapter, or a small PoE switch.</li><li>Yealink, Grandstream, Snom and Polycom phones show up as <b>New phone found</b>. Click <b>Give to…</b> and choose who it's for. The phone sets itself up within a minute (restart it if not).</li><li>Another kind of phone, or a phone app? Use <b>Set up a phone by hand</b> next to the person.</li></ol><p>More: <a class="more" href="${up}help/link.html#desk-phones">Setting up desk phones</a> in the Riyeser Link guide.</p>`],
        ] },
        { title: 'Extensions and calls', items: [
          ['extensions', 'Extension numbers', '<p>Each person gets an extension number, like <b>101</b>. To call someone in the office, pick up a desk phone and dial their extension. Calls inside the office are free.</p>'],
          ['ring-groups', 'Ring groups', '<p>A ring group, like <b>Front desk</b>, rings several phones at once. The first person to answer gets the call.</p>'],
          ['my-phone', 'Answer office calls in the Riyeser Link app', `<p>Staff can also answer office calls in the Riyeser Link app. In Riyeser Link, tap your picture and choose <b>My phone and devices</b> to see your extension and your desk phone. More: <a class="more" href="${up}help/link.html#own-desk-phone">Set up your own desk phone</a>.</p>`],
          ['not-yet', 'What it can\'t do yet', `<p>Calls to and from outside phone numbers, and office phones away from the office, aren't part of Riyeser Link Office yet.</p>${warn('These phones can only call each other. They can\'t call emergency services: keep a mobile or normal phone line for that.')}`],
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
          ['upgrade', 'I need bank reconciliation, payroll or a Balance Sheet', `<p>Click <b>Setup → Upgrade to Accounting Plus</b> and install Accounting Plus. It replaces Basics and opens your books exactly as they are. Plus is free for 90 days, then ${usd(PRICE.plus)} a month per business instead of Basics (never both), with 3 users included. See <a class="more" href="${up}help/accounting.html">the Accounting Plus guide</a>.</p>`],
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
          ['companies', 'Run several companies (groups, trusts or clients)', `<ol><li>Click <b>Companies</b> in the menu, then <b>+ Add company</b>. Each company has its own books and users.</li><li>Switch company from its name at the top of the screen.</li><li><b>Companies</b> also shows cash, money owed, bills and profit for every company and in total.</li></ol><p>Have a company file from another computer or a client? Use <b>Bring in an existing company file</b>. The original isn\'t changed. Your plan includes one company; extra companies are ${usd(PRICE.extra_company)} a month each.</p>`],
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
