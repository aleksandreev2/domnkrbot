# NekromantLib Catalog Translation Status Design

## Goal

Activate the first real RanobeLib-style metadata filter in `/catalog/`: translation status, without inventing data and without changing scanner/delivery semantics.

## Source of truth

Use the multi-team relation model already maintained by production:

- `ranobelib_teams.is_primary = 1` identifies Дом Некроманта;
- `ranobelib_team_translations.presence_state = 'active'` identifies works currently attributed to that team;
- `ranobelib_team_translations.semantic_status` is one of `active`, `completed`, `unknown` and is team-scoped;
- `ranobelib_titles` remains the work metadata table.

Do not infer translation completion from generic manga status. Do not add upstream requests.

## API shape

Extend `getRanobeLibHome()` additively with `catalogTitles` while preserving existing `titles` and `releases` semantics.

`titles` remains the existing active scanner feed used by the home page.

`catalogTitles` includes every snapshot-ready title attributed to the primary team with an active presence relation, including completed translations. Each row adds:

- `translation_semantic_status: 'active' | 'completed' | 'unknown'`;
- `translation_status_label: string | null` as display evidence when available.

This avoids reactivating completed works for scanning merely to keep them visible in the catalog.

## Catalog behavior

`public/catalog.js` prefers `catalogTitles` and falls back to `titles` for compatibility during rollout.

Add URL parameter `translationStatus`, values `active`, `completed`, `unknown`. UI presents:

- `Продолжается` -> `active`;
- `Завершён` -> `completed`;
- `Неизвестно` -> `unknown`.

The captured `Заморожен` and `Заброшен` options remain disabled until a reliable upstream semantic source is persisted.

## Safety

No migration. No writes. No scanner, completion lifecycle, notification delivery, Telegram webhook or discovery behavior changes. The change is an additive read projection plus client-side filtering.

## Acceptance

- completed primary-team translations remain visible in `catalogTitles` even when `ranobelib_titles.is_active = 0`;
- dormant team relations are excluded;
- home `titles` behavior is unchanged;
- catalog URL state includes `translationStatus`;
- filtering uses real `translation_semantic_status` only;
- full CI and discovery guard pass.
