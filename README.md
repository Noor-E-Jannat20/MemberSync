# Group Chat Sync Assistant (prototype v0.3)

A Chrome/Edge/Brave extension (Manifest V3). Keep saved lists of people, check them
against a Messenger group chat, and see who still needs adding. You make every change
in Messenger yourself.

## Use it

1. chrome://extensions > Developer mode > Load unpacked > pick the folder that
   contains `manifest.json`.
2. Open messenger.com (or facebook.com/messages), open the group chat, and open its
   Members list.
3. Click **Sync members** (bottom-left), paste your list, click **Check my list**.

Try it without Facebook: open `demo.html` in Chrome.

## Features

- **Saved lists:** create, switch, rename and delete lists (Volunteers, Class of 2024...).
  Each list autosaves.
- **Flexible entries:** one person per line as a name, a profile link, or `Name | link`.
- **Results in four tabs:** To add, Check, All set, Not listed.
- **Remembered choices:** for close names ("Jon Smith" / "John Smith") you pick
  *Same person* or *Different people* once. It is remembered across lists and sessions,
  works for nicknames ("Bob Chen" = "Robert Chen"), and can be undone or forgotten.
- **Movable:** drag the Sync members button or the panel header anywhere on screen; positions
  are remembered.
- **Text export:** downloads a plain .txt file with sections for To add, Needs a check,
  Not on list and In chat.
- **Guided adding:** steps through the people to add, with profile links, copy buttons
  and an optional pause between adds.
- **Removing from "Not listed":** each row has a Remove button (plus Remove all, Undo and
  Restore). This only hides people in the table and in the exported text; it never
  removes anyone from the Messenger chat.

## Files

    manifest.json   Permissions (storage) and where the script runs
    content.js      Parsing, matching, text export, saved data, and the panel UI
    demo.html       Fake member list to try the panel without Facebook
    test.js         Node tests for the matching and export logic  (node test.js)

In content.js, `scrapeMembers` is the only code that depends on Messenger's page
structure, so it is the part that will need fixing when Facebook changes things.

## Matching rules

1. Same ID or username on both sides: matched.
2. A choice you already made about that pair: applied.
3. Same name (ignoring case, accents, punctuation, word order): matched.
4. Close name: shown in Check for you to decide.
- Two people who both have IDs that differ are always different people.
- Several people sharing a name are never matched automatically.

## Known limits

- Members are read when you click Check. Long lists load as you scroll, so scroll to
  the bottom first. If nothing can be read, a "Paste the members instead" box appears.
- Rows without profile links are read by name only; the chat title and "N members"
  labels are skipped, but other stray labels may slip in.
- List lines that are only a link or ID can't be matched to members whose IDs aren't
  shown. The panel warns you; add names (`Name | link`).
- Only works on the full messenger.com / facebook.com/messages pages.
- Automating or scraping Facebook's pages is against its terms. Keep batches small, test
  on a throwaway chat first, and use an account you can afford to have restricted.
