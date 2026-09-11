# Partner Collaboration Telegram UX

## Product model

`Дом Некроманта` remains the owner, brand, and primary translation team of the bot. Other published RanobeLib teams are presented as cooperation partners, not as peers in a neutral aggregator.

## /start

The root screen must say that this is the official bot of `Дом Некроманта`, keep the existing proposal and site actions, and explicitly mention that partner translations are also available.

Approved copy:

- Title: `Дом Некроманта`
- Body: `Официальный бот команды «Дом Некроманта».` / `Переводы, уведомления и предложения новых новелл.` / blank / `🤝 Здесь также доступны переводы наших партнёров.`
- Buttons: `🔔 Уведомления`, `🤝 Сотрудничества`, `📚 Предложить новеллу`, `🗂 Мои заявки`, `🌐 Сайт`.

`🤝 Сотрудничества` opens the partner-facing catalog and must never expose hidden/paused teams.

## Notifications home

Use the catalog-oriented option B. The home screen is a personal summary, not a flat list of legacy single-team actions.

Display:

- number of whole-team subscriptions;
- number of manually selected team-title translations;
- global delivery mode.

Buttons:

- `⭐ Мои подписки`
- `🧭 Каталог переводов`
- `🔎 Поиск`
- `⚙️ Настройки уведомлений`
- `🏠 Главное меню`

## My subscriptions

Split the user's subscriptions into two explicit concepts:

- whole-team subscriptions (`👥 Мои команды`);
- manually selected translations (`📚 Мои переводы`).

Do not duplicate translations inherited from a whole-team subscription in the manual list.

## Catalog

The catalog hub has four destinations:

- `🏠 Дом Некроманта` — primary team's active translations;
- `🤝 Партнёрские команды` — published non-primary teams;
- `📚 Все активные переводы` — all published active team translations;
- `✅ Завершённые переводы` — all published completed team translations.

Partner team list must exclude the primary team. Primary-team identity must come from `ranobelib_teams.is_primary`, never from hard-coded team IDs in UI rendering.

## Team screen

A partner team screen shows:

- team name;
- active/completed counts;
- whether the user follows the whole team;
- active translations;
- completed translations;
- whole-team follow/unfollow action.

Use cooperation-oriented wording for non-primary teams. The primary team retains `Дом Некроманта` branding and must not be labelled as a partner.

## Work and translation screens

Search stays work-first. If multiple teams translate one work, show a translation picker before the concrete team-title card.

Every concrete translation card must show the translator team explicitly. Where a work has multiple published translations, provide an obvious route to view the other translations without forcing the user to search again.

## Safety / rollout constraints

- Existing subscription semantics and precedence remain unchanged.
- Hidden/paused teams never appear in public UX.
- No historical replay.
- No automatic subscription of existing users to external teams.
- The UI remains controlled by `ranobelib_multi_team_ui`; this UX change must not enable shadow, delivery, or UI flags by itself.
- Primary-team legacy users retain their existing notification meaning after migration.
