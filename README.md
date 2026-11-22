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

## Friends and direct messages
Same sign-in token as the chat room. Everything is under `/social/` (JSON, `Authorization: Bearer <token>`):
`GET state` (friends with online + unread count, incoming and outgoing requests), `POST request {name}` (add by username; a player must have used chat once),
`POST accept {u}`, `POST decline {u}`, `POST cancel {u}`, `POST remove {u}`, `POST dm/send {u, text}`, `GET dm/get?u=&after=`.
Only friends can message each other; a request in both directions makes friends at once. Extra environment variable: `SOCIAL_FILE`.
