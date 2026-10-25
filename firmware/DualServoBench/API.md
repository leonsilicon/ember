# Current V7 HTTP API

Base URL on robot Wi-Fi: `http://192.168.4.1`. No CORS. One active controlling UI.
POST bodies use `application/x-www-form-urlencoded`, NOT JSON.

## POST /session

Empty body. Immediately clears existing wheel/jog commands (servo holding remains),
creates a new automatic session and invalidates the previous token.

Response200: `{"token":12345678}`. This nonce is not a strong authentication scheme;
access is restricted only by the local Wi-Fi password and network topology.

## POST /control

All fields required on **every** frame:

| Field | Values |
|---|---|
| token | Returned positive session token |
| seq | Positive increasing integer; use1,2,3... per session; keep below2147483647 |
| wheel |0 stop,1 forward,2 back,3 pivot left,4 pivot right |
| pan | -1 back,0 stop jogging,+1 forward |
| lift | -1 back,0 stop jogging,+1 forward |
| power | Integer0..100; shared wheel PWM percentage |
| speed | Integer0..100; shared servo jog rate |

Example body:
`token=12345678&seq=1&wheel=1&pan=0&lift=0&power=20&speed=10`

Response200 `{}` means accepted, **not physically achieved**.
400 means malformed request.409 means invalid range/stale session/sequence or
unavailable PWM. Never automatically retry old movement with a new sequence.

While held, send the FULL desired state every100ms. Firmware zeros wheel/jog
commands500ms after the last accepted frame. There is no maximum total hold time.
Stop by sending a NEW sequence with `wheel=0&pan=0&lift=0`, preserving power/speed.
There is **no `/stop` endpoint** in V7; use that zero frame. There is no `/arm`,
`/move` or `/servo` endpoint either: old dashboard APIs are superseded.

Release only one axis by zeroing that axis and retaining the desired state of the
others. Sequence numbers reject late older movement packets after a newer stop.
Do not open multiple independent client instances/tabs competing for one rover.

## GET /status

Example:
`{"ready":true,"sequence":7,"pan":1500,"lift":1500,"pwm":[0,0,0,0]}`

- `ready`: wheel PWM initialization status, NOT hardware readiness/safety.
- `pan`,`lift`: commanded pulse width estimates in microseconds, NOT measured angles.
- `pwm`: software output duty values0..255 in GPIO25,26,32,33 order. No current,
  encoder, physical movement or voltage measurements are available.

## Browser integration

Call a same-origin proxy prefix such as `/robot/control`; proxy strips `/robot`.
UI controls must use pointer capture and zero the relevant axis on pointerup,
pointercancel and lostpointercapture. Clear all held commands on blur/pagehide.
Do not equate100% PWM to a measured speed or current limit.
