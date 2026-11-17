# Reddit Subscription & Saved Sync

A userscript that copies your **subreddit subscriptions** and **saved posts and comments** from one of your Reddit accounts to another, with a **preview** of every change before anything happens.

It is built for people who are changing account, or who have several accounts that have drifted out of step. Extra subreddits on the account you are updating are **kept by default**, so you do not lose things you subscribed to years ago.

## What it does

1. **Snapshot** an account: records its subscriptions and saved items. The snapshot is kept in your browser and also downloaded as a JSON file.
2. **Compare** a snapshot with the account you are logged into. You see:
   - **Missing here**: will be subscribed or saved (ticked by default).
   - **Only on this account**: kept, unless you tick them to unsubscribe (unticked by default).
   - **Already in both.**
3. **Apply** the ticked changes. Before it starts, your account's current lists are downloaded as a backup. Progress is shown at the top of the panel, with a Stop button.

Saved items are only ever added, never removed. They are saved oldest first, so the order carries over.

## Install

1. Install a userscript manager such as [Violentmonkey](https://violentmonkey.github.io/) (tested) or Tampermonkey.
2. Open the raw script: [reddit-subscription-sync.user.js](https://github.com/SiN-180/reddit-subscription-sync/raw/main/reddit-subscription-sync.user.js). Your userscript manager should offer to install it.
3. Go to `https://old.reddit.com` and look for the **Sub sync** button at the bottom right.

The script only runs on `old.reddit.com`. If your browser sends you to the new Reddit site, open the old address directly.

## How to use it

1. Log in to the account you want to copy **from**. Open **Sub sync** and press **Snapshot this account**.
2. Log out and log in to the account you want to **update**.
3. Choose the snapshot, press **Compare**, and review the lists. Untick anything you do not want.
4. Press **Apply** and keep the tab open until it finishes. It runs slowly on purpose (about one action a second) and waits when Reddit asks it to slow down.

You can snapshot as many accounts as you like. To bring an old account's extra subreddits into your main account, snapshot the old account, then compare from your main account.

## Privacy and safety

- It runs inside your already logged-in browser session. It never asks for, reads or stores your password, cookies or API keys.
- Nothing is sent anywhere except to `old.reddit.com`, as you. There is no server, analytics or tracking.
- Snapshots contain the names of your subscriptions and saved items. Treat the downloaded files as private, and do not share them if your subscriptions or saved items are sensitive.
- Imported snapshot files are cleaned before use: only valid subreddit names and item IDs are accepted.

## Limits

- Reddit only shows the latest 1,000 or so saved items, so older ones cannot be copied.
- Banned, private or quarantined subreddits cannot be joined. They are listed as failures in the activity log.
- Reddit can change its site at any time, which may break this script.
- Reddit may have rules about automation. This script acts slowly and only when you press Apply, but you use it at your own risk.
- It has been tested against a mock of Reddit and by hand on the author's own accounts. It has not been widely tested.
- This is an unofficial tool. It is not affiliated with or endorsed by Reddit.

## Licence

[MIT](LICENSE).
