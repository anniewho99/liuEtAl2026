# Firebase version of the AI-assistance experiments

Same task flow as the original (consent, practice, training with AI or tips panel, final no-help block).
Only the plumbing changed: Mongo + Express are gone.

## Before it runs
1. New Firebase project (your other studies use one project each). In the console: enable **Anonymous**
   sign-in (Authentication), create a **Realtime Database**, switch to **Blaze**, register a web app, and paste
   its config into `docs/views/firebaseconfig.js`. `firebasepsych1.0.js` (v1.0, from your grid game) is already in `docs/views/`.
   Deploy rules with `firebase deploy --only database`: participants can only read/write their own `participantData/<uid>`;
   `studyInfo` is open to signed-in users because `blockRandomization` needs it.
2. Hosting is GitHub Pages (site folder is `docs/`). Only the chat function is deployed to Firebase.
   Upgrade the project to Blaze, then:
   ```
   firebase functions:secrets:set OPENAI_API_KEY
   cd functions && npm install && cd ..
   firebase deploy --only functions:aiassist
   ```
   Put the deployed function URL into `window.CHAT_URL` at the top of the module script in both pages
   (replace `YOUR_PROJECT_ID`). The function has CORS enabled so the Pages site can call it.
3. Pages: `/views/reading_experiment.html`, `/views/fractions_experiment.html`.
   Add `?notProlific=1` to write to the `tests` study id instead.
4. `docs/finish.html` still has the placeholder `YOUR_COMPLETION_CODE_HERE`. Put the Prolific code in.

## What gets written (under `<studyId>/participantData/<firebaseUserId>/`)
- `assignedCondition`: "AI" or "control" (block randomized, 0 = AI, 1 = control)
- `participantInfo`: URL params (Prolific PID etc.)
- `trials/<NN>_<puzzle_id>`: solved, skipped, gave_up, user_answer, correct_answer, completion_time_ms, n_chat_messages, puzzle_type, block, order, started_at, timestamp
- `chat/<puzzle_id>/<000..>`: every chat message as it happens (timestamp, sender, message)
- `surveys/<type>`: pre/post Likert, AI-usage question, bot check
- `completedAt`

Study ids: `aiAssistReading`, `aiAssistFractions` (change at the top of each page's module script).

## Other changes
- Fixed: `chat.js` called `getReadingChatContext`, which the fractions page never defined, so the fractions AI didn't see the problem.
- `chat.js` now sends `experiment` so the function picks the right system prompt.
- Chat function: same model and prompts as before, plus input length limits since the endpoint is public.
