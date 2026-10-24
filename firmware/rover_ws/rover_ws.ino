/*
 * rover_ws — ESP32 WebSocket control endpoint for the soon2026 rover + arm.
 *
 * The ESP32 hosts its own Wi-Fi access point and a WebSocket server on /ws.
 * The browser (frontend/) sends JSON commands; the ESP32 replies with status.
 *
 *   Browser -> ESP32:  {"cmd":"forward"|"back"|"left"|"right"|"stop"|"arm_run"}
 *   ESP32 -> Browser:  {"type":"status","drive":"forward","arm":"idle","uptime_ms":1234,"clients":1}
 *                      {"type":"error","message":"arm busy"}
 *
 * Safety rules implemented here:
 *   - Drive commands must keep arriving (frontend sends every 100 ms). If none
 *     arrive for DRIVE_TIMEOUT_MS the motors are stopped.
 *   - When a WebSocket client disconnects the motors are stopped.
 *   - arm_run is rejected while the sequence is running.
 *   - Nothing resumes automatically on reconnect.
 *
 * Motor driver and arm outputs are stubs (see applyDrive / startArmSequence /
 * finishArmSequence). Fill them in once the wiring is known.
 *
 * Libraries (Arduino Library Manager):
 *   - "ESP Async WebServer" by ESP32Async
 *   - "Async TCP" by ESP32Async
 *   - "ArduinoJson" by Benoit Blanchon (v7)
 */

#include <WiFi.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>

// ---------------------------------------------------------------- config ----

static const char* AP_SSID = "rover-ap";
static const char* AP_PASSWORD = "rover1234";  // must be >= 8 characters

static const uint32_t DRIVE_TIMEOUT_MS = 300;    // stop if no drive cmd arrives
static const uint32_t STATUS_INTERVAL_MS = 1000; // heartbeat broadcast period
static const uint32_t ARM_SEQUENCE_MS = 3000;    // placeholder sequence length

#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

// ----------------------------------------------------------------- state ----

enum DriveState { DRIVE_STOP, DRIVE_FORWARD, DRIVE_BACK, DRIVE_LEFT, DRIVE_RIGHT };
enum ArmState { ARM_IDLE, ARM_RUNNING, ARM_COMPLETED, ARM_ERROR };

static AsyncWebServer server(80);
static AsyncWebSocket ws("/ws");

static DriveState driveState = DRIVE_STOP;
static ArmState armState = ARM_IDLE;
static uint32_t lastDriveCommandMs = 0;
static uint32_t armStartedMs = 0;
static uint32_t lastStatusMs = 0;

static const char* driveName(DriveState s) {
  switch (s) {
    case DRIVE_FORWARD: return "forward";
    case DRIVE_BACK: return "back";
    case DRIVE_LEFT: return "left";
    case DRIVE_RIGHT: return "right";
    default: return "stop";
  }
}

static const char* armName(ArmState s) {
  switch (s) {
    case ARM_RUNNING: return "running";
    case ARM_COMPLETED: return "completed";
    case ARM_ERROR: return "error";
    default: return "idle";
  }
}

// ------------------------------------------------------- hardware stubs ----

// TODO(hardware): drive the motor driver for the requested direction.
static void applyDrive(DriveState next) {
  driveState = next;
  digitalWrite(LED_BUILTIN, next != DRIVE_STOP ? HIGH : LOW);
  Serial.printf("[drive] %s\n", driveName(next));
}

// TODO(hardware): start the predefined arm sequence (servo/stepper moves).
static void startArmSequence() {
  armState = ARM_RUNNING;
  armStartedMs = millis();
  Serial.println("[arm] sequence started");
}

// TODO(hardware): called when the sequence should be finished. Decide here
// whether the arm holds position or releases torque.
static void finishArmSequence() {
  armState = ARM_COMPLETED;
  Serial.println("[arm] sequence completed");
}

// -------------------------------------------------------------- messaging ----

static void sendStatus(AsyncWebSocketClient* client = nullptr) {
  JsonDocument doc;
  doc["type"] = "status";
  doc["drive"] = driveName(driveState);
  doc["arm"] = armName(armState);
  doc["uptime_ms"] = millis();
  doc["clients"] = ws.count();
  String out;
  serializeJson(doc, out);
  if (client != nullptr) {
    client->text(out);
  } else {
    ws.textAll(out);
  }
}

static void sendError(AsyncWebSocketClient* client, const char* message) {
  JsonDocument doc;
  doc["type"] = "error";
  doc["message"] = message;
  String out;
  serializeJson(doc, out);
  client->text(out);
}

static void handleCommand(AsyncWebSocketClient* client, const char* cmd) {
  if (strcmp(cmd, "forward") == 0) {
    applyDrive(DRIVE_FORWARD);
  } else if (strcmp(cmd, "back") == 0) {
    applyDrive(DRIVE_BACK);
  } else if (strcmp(cmd, "left") == 0) {
    applyDrive(DRIVE_LEFT);
  } else if (strcmp(cmd, "right") == 0) {
    applyDrive(DRIVE_RIGHT);
  } else if (strcmp(cmd, "stop") == 0) {
    applyDrive(DRIVE_STOP);
  } else if (strcmp(cmd, "arm_run") == 0) {
    if (armState == ARM_RUNNING) {
      sendError(client, "arm busy");
      return;
    }
    startArmSequence();
    sendStatus();
    return;
  } else {
    sendError(client, "unknown command");
    return;
  }
  lastDriveCommandMs = millis();
  sendStatus();
}

static void onWsEvent(AsyncWebSocket* /*srv*/, AsyncWebSocketClient* client, AwsEventType type,
                      void* arg, uint8_t* data, size_t len) {
  switch (type) {
    case WS_EVT_CONNECT:
      Serial.printf("[ws] client %u connected from %s\n", client->id(),
                    client->remoteIP().toString().c_str());
      sendStatus(client);
      break;

    case WS_EVT_DISCONNECT:
      Serial.printf("[ws] client %u disconnected\n", client->id());
      // Whoever was driving may have been this client: fail safe and stop.
      if (driveState != DRIVE_STOP) {
        applyDrive(DRIVE_STOP);
      }
      break;

    case WS_EVT_DATA: {
      AwsFrameInfo* info = static_cast<AwsFrameInfo*>(arg);
      // Only handle complete, single-frame text messages (commands are tiny).
      if (!(info->final && info->index == 0 && info->len == len && info->opcode == WS_TEXT)) {
        sendError(client, "fragmented message not supported");
        return;
      }
      JsonDocument doc;
      DeserializationError err = deserializeJson(doc, data, len);
      if (err) {
        sendError(client, "invalid json");
        return;
      }
      const char* cmd = doc["cmd"];
      if (cmd == nullptr) {
        sendError(client, "missing cmd");
        return;
      }
      handleCommand(client, cmd);
      break;
    }

    case WS_EVT_ERROR:
      Serial.printf("[ws] client %u error\n", client->id());
      break;

    default:
      break;
  }
}

// ------------------------------------------------------------------ setup ----

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  applyDrive(DRIVE_STOP);

  WiFi.mode(WIFI_AP);
  if (!WiFi.softAP(AP_SSID, AP_PASSWORD)) {
    Serial.println("[wifi] softAP failed");
  }
  Serial.printf("[wifi] AP \"%s\" up, IP %s\n", AP_SSID, WiFi.softAPIP().toString().c_str());

  ws.onEvent(onWsEvent);
  server.addHandler(&ws);
  server.on("/", HTTP_GET, [](AsyncWebServerRequest* request) {
    request->send(200, "text/plain", "rover_ws OK. WebSocket endpoint: /ws");
  });
  server.begin();
  Serial.println("[ws] server started on port 80, endpoint /ws");
}

// ------------------------------------------------------------------- loop ----

void loop() {
  const uint32_t now = millis();

  if (driveState != DRIVE_STOP && (now - lastDriveCommandMs) > DRIVE_TIMEOUT_MS) {
    Serial.println("[drive] watchdog timeout");
    applyDrive(DRIVE_STOP);
    sendStatus();
  }

  if (armState == ARM_RUNNING && (now - armStartedMs) >= ARM_SEQUENCE_MS) {
    finishArmSequence();
    sendStatus();
  }

  if ((now - lastStatusMs) >= STATUS_INTERVAL_MS) {
    lastStatusMs = now;
    if (ws.count() > 0) sendStatus();
  }

  ws.cleanupClients();
}
