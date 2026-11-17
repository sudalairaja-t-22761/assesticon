# Icon Assets bot for Zoho Cliq — setup, step by step

The approval flow sends every notification by mail and by Cliq. Cliq cards carry buttons (Approve, Reject,
Push, Decline); pressing one opens a small form and then calls the Icon Assets server.

**Nobody has to subscribe to the bot.** The server posts to the bot first. If Cliq does not accept that for a
person (they never opened the bot), the same card with the same buttons is sent automatically as a direct chat
message. A direct message arrives in the person's chat with the owner of the webhook token (step 2), shown
under the name "Icon Assets".

## Steps

1. **Create the bot.**
   Cliq → your profile picture → **Bots & Tools** → **Bots** → **Create Bot**.
   Name: `Icon Assets`. Access level: **Organisation** (or the team that holds every approver, requester and admin).
   Save, then copy the bot's **unique name** (shown in the bot's details / API URL).

2. **Create a webhook token.**
   Bots & Tools → **Webhook Tokens** → **Generate**. Copy the token.
   Create it from the account that should appear as the sender of direct messages.

3. **Create the button function.**
   Bots & Tools → **Functions** → **Create Function**.
   Name: `iconaction`. Function type: **Button**.
   Delete the sample code, paste the whole of `cliq/iconaction.button.dg`, save.

4. **Choose a secret.**
   In a terminal run `openssl rand -hex 24` and copy the output (48 characters).

5. **Create the form function.**
   Create Function again. Name: `iconactionform`. Function type: **Form**.
   Paste the whole of `cliq/iconactionform.form.dg`, then set the two values at the top:
   - `apiUrl` → `https://<your Catalyst domain>/server/spriteForgeJoin/api/cliq/action`
     (the same domain as `APP_URL` in `.env.production`)
   - `actionToken` → the secret from step 4

   Save.

6. **Server settings.**
   Add to `functions/spriteForgeJoin/.env.production`:

   ```
   CLIQ_BOT_NAME=<unique name from step 1>
   CLIQ_BOT_TOKEN=<token from step 2>
   CLIQ_ACTION_TOKEN=<secret from step 4>
   ```

7. **Deploy** the `spriteForgeJoin` function.

8. **Optional, needs Cliq admin rights:** in the Cliq Admin Panel mark the bot as a **default bot** for the
   organisation or team. New members are then subscribed automatically and get the cards in the bot's own chat
   instead of a direct message.

## Tests

9. **Test message.** App → **Icon Requests** (as admin) → **Send test Cliq message to me**.
   The result line says whether it went through the bot or as a direct message.

10. **Fresh-user check.** Pick one approver who has never opened the bot. Raise a test request and confirm they
    receive the card without doing anything. If they receive nothing and the request timeline shows no Cliq
    failure, Cliq is dropping bot messages to non-subscribers silently. In that case add
    `CLIQ_DELIVERY=direct` to `.env.production` and deploy again: every card then goes as a direct message.

11. **Full flow.** Approve with a note → the UI audit approvers get their card → approve → only admins get
    **Push to mock branch**. Push only a test icon: it makes a real commit and a new npm version.

Check these on the first run, because they depend on the Cliq side:

- the icon preview shows in the card (Cliq must be able to reach the Catalyst URL);
- the note form opens from the buttons, and the answer of the server shows after submitting;
- the push finishes before Cliq's function time limit. If Cliq reports a timeout, the push may still have
  completed: check the request in the app before pressing again (a second press answers "Already pushed").

## Optional settings

```
# CLIQ_DELIVERY=bot-first        bot-first (default) | direct = always send the direct message
# CLIQ_DIRECT_FALLBACK=true      false = never fall back to a direct message
# CLIQ_SENDER_NAME=Icon Assets   name shown on a direct message
# CLIQ_FUNCTION=iconaction       name of the button function
# CLIQ_BASE=https://cliq.zoho.in
# API_PUBLIC_URL=https://<your Catalyst domain>/server/spriteForgeJoin
```

## Who gets what

| Step | Approvers | Requester | Admins |
|---|---|---|---|
| Request raised | Visual audit: approval card | – (they raised it) | status |
| Visual audit approved | UI audit: approval card | status | status |
| Visual / UI audit rejected | – | status + note | status + note |
| UI audit approved (both passed) | – | status | **push card** |
| Pushed | – | status | status |
| Master push declined | – | status + note | status |
| npm version published / failed | – | version | version |

The person who performs a step is not notified about their own action. Each message is also sent by mail.
