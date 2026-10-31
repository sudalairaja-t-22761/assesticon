# spriteAppend

Catalyst Advanced I/O function that appends individual SVG icons to the icon library sprite

    Iconassest / Sprite/crmutil_icons.svg   (ZohoRepository, branch `default`)

and commits + pushes the result.

What it guarantees:

- The existing sprite is never rewritten. Every existing `<symbol>` keeps its id, position and order.
- New icons are placed after the last existing icon; every spot is checked against all existing viewBoxes, so nothing overlaps.
- New `<symbol>`s are appended at the bottom of the file (right before `</svg>`); their `<g>` groups go before the first `<symbol>`, like the sprite's own entries.
- An icon whose symbol id already exists is skipped, never overwritten.
- The icon name is the file name without `.svg`, kept as typed (case, `-`, `_`, `.`); the sprite's `zcicn-` prefix is added unless the name already has it.

## Endpoints

Deployed base: `https://<project>.catalystserverless.in/server/spriteAppend`

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/sprite/health` | public: repo / branch / file / limits, is the token configured |
| GET | `/api/sprite/icons` | symbol ids + viewBoxes at the branch tip |
| GET | `/api/sprite/file` | the current sprite (`image/svg+xml`) |
| POST | `/api/sprite/check` | `{ svg }` → overlaps and duplicate ids of any sprite text |
| POST | `/api/sprite/append` | add icons (below) |

Auth: `SPRITE_API_TOKEN` sent as `x-api-token: <token>`, `Authorization: Bearer <token>` or `?token=`.
Why: the function holds the repository write token and commits on every call, and a Catalyst function URL has no login in front of it. To run it without any token set `SPRITE_API_PUBLIC=true` (then anyone with the URL can append icons).
Optional `x-user-name` / `x-user-email` headers become the commit author.

### POST /api/sprite/append

Multipart (any field names, one part per `.svg`):

```bash
curl -H "x-api-token: $TOKEN" \
  -F "files=@home.svg" -F "files=@calendar.svg" \
  -F "message=Add home, calendar" \
  https://<project>.catalystserverless.in/server/spriteAppend/api/sprite/append
```

JSON:

```json
{
  "icons": [
    { "name": "home.svg", "svg": "<svg …>" },
    { "name": "calendar.svg", "data": "<base64>", "encoding": "base64" }
  ],
  "message": "Add home, calendar",
  "dryRun": false,
  "prefix": "zcicn-"
}
```

Optional fields: `dryRun` (compute and return the new sprite as `svg`, commit nothing), `prefix` (symbol id prefix, `""` for none), `spacing`, `rowGap`, `padding` (layout, in sprite px).

Response:

```json
{
  "success": true,
  "added":   [{ "name": "home", "symbolId": "zcicn-home", "gId": "homeZCI", "viewBox": "136 1970 24 24", "x": 136, "y": 1970, "width": 24, "height": 24 }],
  "skipped": [{ "name": "xss", "symbolId": "zcicn-xss", "reason": "already in the sprite" }],
  "changed": true, "pushed": true, "commit": "<sha>", "branch": "default",
  "file": "Sprite/crmutil_icons.svg", "webUrl": "https://repository.zohocorpcloud.in/…",
  "size": { "before": { "width": 425, "height": 2099 }, "after": { "width": 425, "height": 2184 } },
  "check": { "symbols": 813, "overlaps": [], "preexisting": { "overlaps": 24, "duplicateIds": ["zcicn-nofolder"] } }
}
```

`check.overlaps` lists overlaps involving a new icon (the append is refused if any). `check.preexisting` reports problems the sprite already had; they never block an append.

## Configuration

See `.env.example`. Required: `ICON_REPO_TOKEN` (or `REPO_TOKEN`) with write access to Iconassest, and `SPRITE_API_TOKEN`. On Catalyst set them in Console → Functions → spriteAppend → Environment Variables (or `.env.production`); without `SPRITE_API_TOKEN` the deployed API answers 503.

## Run / deploy

```bash
npm run dev:append       # local: http://localhost:3003/api/sprite (reads functions/spriteAppend/.env)
npm run deploy:append    # catalyst deploy --only functions:spriteAppend
```

`lib/repo-client.js` and `lib/repo-config.js` are copies of the spriteForgeJoin ones; `lib/sprite-append.js` is a server-side port of the Library page's `SF.addIconsToSpriteText` (repo-library-icons.js, layout.js, svg-parser.js).
