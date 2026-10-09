DIGITALRYZE WEBSITE CHATBOT

What's inside
  api/chat.js          Backend. Talks to Claude and saves leads.
  lib/prompt.js        The bot's brain: behaviour rules + all FAQ answers. Edit this to update what it knows.
  public/widget.js     The chat bubble that appears on your website.
  public/index.html    A test page (open your Vercel URL to try the bot).
  apps-script/Code.gs  Paste into Google Sheets. Saves each lead to the sheet and emails you.

Setup (about 20 minutes)

1. Google Sheet + email alerts
   - Create a new Google Sheet called "DigitalRyze Chatbot Leads".
   - Extensions > Apps Script. Delete the sample code and paste in apps-script/Code.gs.
   - Change SECRET to a long random string and NOTIFY_EMAIL to your email. Save.
   - Deploy > New deployment > type: Web app. Execute as: Me. Who has access: Anyone. Deploy.
   - Approve the permissions, then copy the Web app URL (ends in /exec).

2. Claude API key
   - Go to console.anthropic.com, add billing, and create an API key.

3. Deploy to Vercel
   - Upload this folder to a new GitHub repo, then in Vercel: Add New > Project > import the repo.
     (Or install the Vercel CLI and run "vercel" inside this folder.)
   - Framework preset: Other. No build command needed.
   - Add Environment Variables:
       ANTHROPIC_API_KEY     your Claude API key
       LEAD_WEBHOOK_URL      the Apps Script Web app URL from step 1
       LEAD_WEBHOOK_SECRET   the same SECRET you set in Code.gs
       ALLOWED_ORIGINS       https://digitalryze.com,https://www.digitalryze.com
       CLAUDE_MODEL          (optional) defaults to claude-sonnet-5-5. Use claude-haiku-4-5-20251001 for lower cost.
   - Deploy. Open https://YOUR-PROJECT.vercel.app to test on the test page.

4. Add to digitalryze.com
   Paste this before the closing </body> tag on every page (on WordPress, use a header/footer
   code plugin such as WPCode, set to "Site Wide Footer"):

     <script src="https://YOUR-PROJECT.vercel.app/widget.js" data-color="#2F5BFF" defer></script>

   Change data-color to your brand colour.

Updating the bot
  Edit lib/prompt.js (it holds both the rules and the FAQ answers), commit, and Vercel redeploys automatically.
