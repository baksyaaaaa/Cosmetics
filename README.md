# Chrome Client cosmetics + chat service

Plain Node (18+), no dependencies. `node server.js`.

- `POST /set`, `GET /get?u=uuid,uuid` : the cosmetics players share with each other.
- Chat (one shared room), players sign in with Mojang's own check:
  1. `POST /chat/nonce` -> `{nonce}`
  2. the game calls Mojang `joinServer` using the nonce as the server id
  3. `POST /chat/login {name, nonce}` -> `{token, uuid, name}`
  4. `POST /chat/send {text}` and `GET /chat/get?after=<id>` with `Authorization: Bearer <token>`

Settings (environment variables): `PORT`, `DATA_FILE`, `CHAT_FILE`, `CHAT_BANNED` (comma separated uuids that cannot chat), `MOJANG_URL` (for tests).
Messages are cut to 200 characters, one per 1.2 s and 20 per minute per player, and the last 300 are kept.
