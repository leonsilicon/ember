# rover_ws — ESP32 firmware

WebSocket control endpoint for the rover + arm. The ESP32 hosts its own Wi-Fi
network, so no router is needed: join the laptop to the ESP32's network and point
the web app at it.

Motor and arm outputs are **stubs** (the onboard LED lights while driving). Fill in
`applyDrive`, `startArmSequence` and `finishArmSequence` once wiring is known.

## Flash (Arduino IDE, macOS)

1. Install [Arduino IDE 2](https://www.arduino.cc/en/software).
2. **Settings → Additional boards manager URLs**, add
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`.
3. **Tools → Board → Boards Manager**, install **esp32** by Espressif Systems.
4. **Tools → Manage Libraries**, install:
   - **ESP Async WebServer** (ESP32Async)
   - **Async TCP** (ESP32Async)
   - **ArduinoJson** (Benoit Blanchon, v7.x)
5. Plug the ESP32 in over USB-C. **Tools → Board** → `ESP32 Dev Module` (or your exact
   board if listed). **Tools → Port** → the `/dev/cu.usbserial-*` or `/dev/cu.usbmodem*`
   entry. If no port appears you may need the CP210x or CH340 USB driver for your board.
6. Open `rover_ws.ino` and click **Upload**. If it hangs on `Connecting...`, hold the
   board's **BOOT** button until upload starts.
7. **Tools → Serial Monitor** at 115200 baud. You should see:
   ```
   [wifi] AP "rover-ap" up, IP 192.168.4.1
   [ws] server started on port 80, endpoint /ws
   ```

## Connect the laptop

1. Join Wi-Fi network **`rover-ap`**, password **`rover1234`** (edit at the top of the
   sketch). The laptop loses internet while joined; the web app's dev server (`bun run dev` in `frontend/`) runs locally so
   that's fine.
2. In the web app switch to **Live**, URL `ws://192.168.4.1/ws`, click **Connect**.
3. Hold a direction: the onboard LED lights, the Serial Monitor prints `[drive] forward`,
   and the app shows the device-reported drive state. Release: `[drive] stop`.
4. **Run arm sequence**: status goes `running` for 3 s then `completed`. Clicking again
   while running returns `{"type":"error","message":"arm busy"}`.

Sanity check without the app: `http://192.168.4.1/` returns `rover_ws OK`.

## Test Live mode without an ESP32

`mock_server.py` is a dependency-free Python stand-in that speaks the same protocol
and applies the same rules (watchdog, arm busy, heartbeat):

```sh
python3 firmware/rover_ws/mock_server.py          # ws://127.0.0.1:8080/ws
```

Then in the app: **Live** → `ws://127.0.0.1:8080/ws` → **Connect**.

## Protocol

| Direction | Message |
|---|---|
| browser → ESP32 | `{"cmd":"forward"}` `{"cmd":"back"}` `{"cmd":"left"}` `{"cmd":"right"}` `{"cmd":"stop"}` `{"cmd":"arm_run"}` |
| ESP32 → browser | `{"type":"status","drive":"stop","arm":"idle","uptime_ms":1234,"clients":1}` |
| ESP32 → browser | `{"type":"error","message":"arm busy"}` |

Status is sent after every command and broadcast once per second as a heartbeat.

## Safety behaviour

- Drive commands must arrive at least every **300 ms** (`DRIVE_TIMEOUT_MS`) or the motors
  stop. The frontend re-sends the held direction every 100 ms.
- Motors stop whenever a WebSocket client disconnects.
- `arm_run` is ignored (with an error reply) while the sequence is running.
- Nothing resumes automatically after a reconnect.
