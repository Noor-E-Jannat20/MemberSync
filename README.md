# Group Chat Sync Assistant (v0.4)

A Chrome / Edge / Brave extension (Manifest V3) that compares a list of people you keep
against the members of a Messenger group chat. It shows who still needs adding, who is in
the chat but not on your list, and who is already there.

**It only reads the page and helps you keep track. You make every change in Messenger
yourself.** Nothing is ever clicked, added or removed in the chat for you.

---

## Contents

1. [Install](#install)
2. [Quick start](#quick-start)
3. [Writing your list](#writing-your-list)
4. [Reading the results](#reading-the-results)
5. [Features](#features)
6. [Moving the button and panel](#moving-the-button-and-panel)
7. [How matching works](#how-matching-works)
8. [Try it without Facebook](#try-it-without-facebook)
9. [Files](#files)
10. [Troubleshooting](#troubleshooting)
11. [Known limits](#known-limits)

---

## Install

1. Unzip the folder so that `manifest.json` sits directly inside it.
2. In Chrome, Edge or Brave open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose the folder that contains `manifest.json`.
5. Reload any open Messenger tab. A black **Sync members** button with a glowing red
   border appears on the page.

The extension needs only the `storage` permission (to save your lists and choices on
your own browser). It runs on `messenger.com` and `facebook.com/messages`.

## Quick start

1. Open messenger.com (or facebook.com/messages) and open the group chat.
2. Open the chat's **Members** list and **scroll to the bottom** so every member has loaded.
3. Click **Sync members**.
4. Type or paste the people who should be in the chat, one per line.
5. Click **Check my list**.
6. Go through the four result tabs, then add anyone missing, using **Start adding** if you
   like.

## Writing your list

One person per line. Each line can be:

| You write | Example |
|---|---|
| A name | `Lena Petrova` |
| A profile link | `https://facebook.com/some.username` |
| A numeric ID | `100000000002` |
| A name and a link or ID | `Daniel Okafor \| facebook.com/profile.php?id=100000000002` |

Tips:

- Names alone work fine. Adding a link or ID as well makes matching exact.
- A line made only of links or IDs can be separated with commas: `id1, id2, id3`.
- Messenger thread links (`messenger.com/t/...`) and short links (`fb.me/...`) can't be used.
  Lines that can't be read are skipped and reported on the results screen.
- Your list autosaves as you type.

## Reading the results

After **Check my list** you see a progress bar ("12 of 15 are in the chat") and four tabs:

| Tab | Meaning |
|---|---|
| **To add** | On your list, not in the chat. |
| **Check** | A close name match that needs your decision (for example Jon Smith / John Smith). |
| **All set** | On your list and in the chat. Shows how each was matched (ID, name or remembered). |
| **Not listed** | In the chat but not on your list. |

## Features

### Saved lists
Create, switch, rename and delete lists (for example "Volunteers" or "Class of 2024") from
the picker at the top of the panel. **Delete** asks you to click a second time to confirm.

### Remembered choices
In the **Check** tab, choose **Same person** or **Different people** for each close pair.
The answer is remembered across lists and sessions. This also covers nicknames, such as
Bob Chen = Robert Chen. You can undo a choice right after making it. Later, open
**All set > Remembered choices** and press **Forget** to be asked again.

### Reading only the Members list
The extension does not read the whole screen. On **Check my list** it looks for, in order:

1. an area you picked yourself,
2. an open Members pop-up,
3. the section under a "Chat members" / "Members" heading.

The sidebar chat list, the message area and the page header are ignored. The area it read
flashes with a red outline so you can see what was used.

If it can't find the list, or reads the wrong area, click **Select member list** (under
the list box), then click any member's name inside the real Members list. Hovering shows a
red outline of the area that will be used; press Esc to cancel. **Reset** goes back to
auto-detect. The picked area is remembered until the page reloads or the area leaves the page.

### Removing people from the "Not listed" table
Each row has a **Remove** button. **Remove all** clears the table. A message offers **Undo**,
and a **Restore** link brings back everyone you hid.

This only tidies the table. It does not remove anyone from the Messenger chat. Removed
people are left out of **Copy names** and the text download. Running a new check starts
fresh with everyone shown again.

### Copy names
In **Not listed**, **Copy names** copies the visible names to your clipboard, one per line.

### Download a text file
**Download .txt** saves a plain text report named like `volunteers-2026-10-14.txt`. It has
a summary line and four sections: TO ADD, NEEDS A CHECK, NOT ON LIST and IN CHAT. It works
from both the results screen and the finish screen.

### Guided adding
When people are missing, **Start adding (N)** steps through them one at a time:

- **Open profile** opens their Facebook profile (when you gave a link or ID) so you can
  confirm it's the right person.
- **Copy name** or **Copy ID** puts it on your clipboard to paste into Messenger's add box.
- **Added them** or **Skip** moves to the next person.
- **Take a short breather between adds** (on by default) adds a short pause of 6 to 15
  seconds after each add, so you aren't adding people too fast. Untick it to turn it off.

When you finish, **Re-check the chat** confirms the chat now matches your list.

### Look and feel
Red, white and black theme with a light and a dark mode that follow your system setting.
Animations are switched off if your system asks for reduced motion.

## Moving the button and panel

- **Button:** press and drag **Sync members** anywhere on the screen. A plain click still
  opens and closes the panel. (With the keyboard, focus it and press Enter or Space.)
- **Panel:** drag its black header bar.
- Until you move the panel yourself, it opens next to the button, above it when the button
  is low on the screen and below it when the button is high.
- Positions are remembered, and they are kept on screen if you resize the window.

## How matching works

Checked in this order:

1. **Same ID or username** on both sides: matched.
2. **A choice you already made** for that pair: applied.
3. **Same name** (ignoring case, accents, punctuation and word order): matched.
4. **Close name**: sent to the **Check** tab for you to decide.

Safety rules:

- Two people who both have IDs that differ are always treated as different people.
- If several people share a name, they are never matched automatically. They go to **Check**.

## Try it without Facebook

Open `demo.html` in Chrome (with the extension loaded). It shows a fake member list. Click
**Sync members**, paste this list, and press **Check my list**:

    Amina Rahman
    Lena Petrova | facebook.com/lena.petrova
    Tomas Rivera
    Jon Smith
    Priya Nair

Expected: Amina, Lena and Tomas are in **All set**; Jon Smith is in **Check** (close to
John Smith); Priya Nair is in **To add**; Random Person is in **Not listed**.

## Files

    manifest.json   Permissions (storage) and the pages the script runs on
    content.js      Parsing, matching, text export, saved data and the panel UI
    demo.html       Fake member list for trying the panel without Facebook
    test.js         Tests for the matching and export logic  (run: node test.js)
    README.md       This file

`scrapeMembers` in `content.js` is the only code that depends on Messenger's page layout,
so it is the part to fix if Facebook changes things.

## Troubleshooting

- **No button appears:** make sure the extension is enabled, you are on messenger.com or
  facebook.com/messages, and you reloaded the tab after installing.
- **"I couldn't see any chat members":** open the chat's Members list, scroll to the bottom
  and click **Check my list** again. If it still fails, a **Paste the members instead** box
  appears: paste one member name per line there.
- **Names from outside the member list show up:** click **Select member list** and pick
  the list yourself (see above). Use **Remove** in **Not listed** to hide any leftovers.
- **Some members are missing:** the member list loads as you scroll. Scroll to the very
  bottom before checking.
- **A stray label shows up as a member:** rows without profile links are read by name, so
  an occasional UI label can slip in. Use **Remove** in **Not listed** to hide it.
- **Link-only lines can't be matched:** if some chat members show no ID, lines with only a
  link or ID can't be matched to them. The panel warns you. Write them as `Name | link`.
- **The button is off screen or in the way:** drag it somewhere else.

## Known limits

- Members are read when you click **Check my list**, not live.
- Works only on the full messenger.com and facebook.com/messages pages.
- Your lists, choices, settings and positions are stored in your browser only
  (`chrome.storage.local`). They are not synced to other devices.
- Automating or scraping Facebook's pages is against its terms. Keep batches small, test on
  a throwaway chat first, and use an account you can afford to have restricted.
