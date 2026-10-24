// Rover motor controller for an ESP32 (ELEGOO ESP-WROOM-32 boards) driven by the app over BLE.
//
// The phone does the perception and decides where to go; this board only runs the two drive
// motors through a dual H-bridge (L298N, TB6612FNG or similar) and stops them on its own when
// the phone goes quiet, so a dropped connection can never leave the rover driving.
//
// BLE protocol (keep in sync with src/lib/rover.ts):
//   Service    b6960001-fcac-4307-b328-64175bf8c076
//   Drive      b6960002-...  write / write without response, 2 bytes:
//                [0] int8 left speed, [1] int8 right speed, each -100..100 (percent, + = forward)
//   Telemetry  b6960003-...  read / notify at 5 Hz, 10 bytes:
//                [0] int8 left speed applied, [1] int8 right speed applied,
//                [2] uint8 flags (bit 0 = stopped by the watchdog), [3] uint8 protocol version,
//                [4..5] uint16 LE battery millivolts (0 = not measured), [6..9] uint32 LE uptime ms
//
// Flash with Arduino IDE or arduino-cli, using the "esp32" core (Espressif, 3.x) and board
// "ESP32 Dev Module":
//   arduino-cli compile --upload -b esp32:esp32:esp32 -p /dev/cu.usbserial-XXXX firmware/rover

#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>

// ---- Wiring: change these to match your board -------------------------------------------------

struct Motor {
  uint8_t pwm;  // ENA / ENB (L298N: remove the jumper) or PWMA / PWMB (TB6612FNG)
  uint8_t in1;  // IN1 / IN3 or AIN1 / BIN1
  uint8_t in2;  // IN2 / IN4 or AIN2 / BIN2
  bool inverted;  // flip if this side drives backwards when told to go forward
};

constexpr Motor kLeft = {25, 26, 27, false};
constexpr Motor kRight = {23, 22, 21, false};

constexpr int kStatusLedPin = 2;  // the blue on-board LED on most ESP32 dev boards

// Battery sense through a resistor divider into an ADC1 pin (32-39), or -1 if not wired.
// Example: battery+ -> 20k -> GPIO34 -> 10k -> GND gives a ratio of 3.0 (safe up to ~9.9 V).
constexpr int kBatteryPin = -1;
constexpr float kBatteryDividerRatio = 3.0f;

constexpr uint32_t kPwmFrequency = 5000;
constexpr uint8_t kPwmBits = 8;
// Lowest duty that still turns the motors; raise it (e.g. 80) if they hum but don't move at low
// speeds. Any non-zero speed is mapped into kMinDuty..255.
constexpr uint8_t kMinDuty = 0;

// Stop if no drive command arrives for this long. The app resends commands every 50 ms.
constexpr uint32_t kCommandTimeoutMs = 500;
constexpr uint32_t kTelemetryIntervalMs = 200;

// ---- Protocol ----------------------------------------------------------------------------------

#define SERVICE_UUID "b6960001-fcac-4307-b328-64175bf8c076"
#define DRIVE_UUID "b6960002-fcac-4307-b328-64175bf8c076"
#define TELEMETRY_UUID "b6960003-fcac-4307-b328-64175bf8c076"

constexpr uint8_t kProtocolVersion = 1;
constexpr uint8_t kFlagWatchdogStopped = 1 << 0;

// ---- State shared between the BLE callbacks and loop() ------------------------------------------

portMUX_TYPE commandLock = portMUX_INITIALIZER_UNLOCKED;
int8_t targetLeft = 0;
int8_t targetRight = 0;
uint32_t lastCommandAt = 0;
bool hasCommand = false;

volatile bool connected = false;
volatile bool restartAdvertising = false;

BLECharacteristic *telemetry = nullptr;
int8_t appliedLeft = 0;
int8_t appliedRight = 0;
bool watchdogStopped = false;

// ---- Motors ----------------------------------------------------------------------------------

void attachPwm(uint8_t pin, uint8_t channel) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  (void)channel;
  ledcAttach(pin, kPwmFrequency, kPwmBits);
#else
  ledcSetup(channel, kPwmFrequency, kPwmBits);
  ledcAttachPin(pin, channel);
#endif
}

void writePwm(uint8_t pin, uint8_t channel, uint32_t duty) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  (void)channel;
  ledcWrite(pin, duty);
#else
  (void)pin;
  ledcWrite(channel, duty);
#endif
}

void setupMotor(const Motor &motor, uint8_t channel) {
  pinMode(motor.in1, OUTPUT);
  pinMode(motor.in2, OUTPUT);
  digitalWrite(motor.in1, LOW);
  digitalWrite(motor.in2, LOW);
  attachPwm(motor.pwm, channel);
  writePwm(motor.pwm, channel, 0);
}

/** speed is -100..100; 0 lets the motor coast. */
void driveMotor(const Motor &motor, uint8_t channel, int8_t speed) {
  int value = constrain(motor.inverted ? -speed : speed, -100, 100);
  digitalWrite(motor.in1, value > 0 ? HIGH : LOW);
  digitalWrite(motor.in2, value < 0 ? HIGH : LOW);
  uint32_t duty = value == 0 ? 0 : map(abs(value), 1, 100, kMinDuty > 0 ? kMinDuty : 1, 255);
  writePwm(motor.pwm, channel, duty);
}

void applySpeeds(int8_t left, int8_t right) {
  if (left == appliedLeft && right == appliedRight) return;
  driveMotor(kLeft, 0, left);
  driveMotor(kRight, 1, right);
  appliedLeft = left;
  appliedRight = right;
}

// ---- BLE ---------------------------------------------------------------------------------------

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    connected = true;
  }

  void onDisconnect(BLEServer *server) override {
    connected = false;
    portENTER_CRITICAL(&commandLock);
    targetLeft = 0;
    targetRight = 0;
    hasCommand = false;
    portEXIT_CRITICAL(&commandLock);
    restartAdvertising = true;
  }
};

class DriveCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    if (characteristic->getLength() < 2) return;
    const uint8_t *data = characteristic->getData();
    portENTER_CRITICAL(&commandLock);
    targetLeft = constrain(static_cast<int8_t>(data[0]), -100, 100);
    targetRight = constrain(static_cast<int8_t>(data[1]), -100, 100);
    lastCommandAt = millis();
    hasCommand = true;
    portEXIT_CRITICAL(&commandLock);
  }
};

void setupBle() {
  // A suffix from the chip's MAC tells boards from the same pack apart in the app.
  char name[24];
  snprintf(name, sizeof(name), "soon-rover-%04X", static_cast<uint16_t>(ESP.getEfuseMac() >> 32));
  BLEDevice::init(name);

  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  BLEService *service = server->createService(SERVICE_UUID);

  BLECharacteristic *drive = service->createCharacteristic(
      DRIVE_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  drive->setCallbacks(new DriveCallbacks());

  telemetry = service->createCharacteristic(
      TELEMETRY_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  telemetry->addDescriptor(new BLE2902());

  service->start();

  // The 128-bit service UUID fills most of the advertisement, so the name goes in the scan
  // response. The app scans for the service UUID.
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.printf("Advertising as %s\n", name);
}

uint16_t readBatteryMillivolts() {
  if (kBatteryPin < 0) return 0;
  return static_cast<uint16_t>(analogReadMilliVolts(kBatteryPin) * kBatteryDividerRatio);
}

void sendTelemetry() {
  uint16_t battery = readBatteryMillivolts();
  uint32_t uptime = millis();
  uint8_t packet[10] = {
      static_cast<uint8_t>(appliedLeft),
      static_cast<uint8_t>(appliedRight),
      static_cast<uint8_t>(watchdogStopped ? kFlagWatchdogStopped : 0),
      kProtocolVersion,
      static_cast<uint8_t>(battery),
      static_cast<uint8_t>(battery >> 8),
      static_cast<uint8_t>(uptime),
      static_cast<uint8_t>(uptime >> 8),
      static_cast<uint8_t>(uptime >> 16),
      static_cast<uint8_t>(uptime >> 24),
  };
  telemetry->setValue(packet, sizeof(packet));
  telemetry->notify();
}

// ---- Main loop ---------------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  pinMode(kStatusLedPin, OUTPUT);
  setupMotor(kLeft, 0);
  setupMotor(kRight, 1);
  setupBle();
}

void loop() {
  uint32_t now = millis();

  int8_t left, right;
  bool fresh;
  portENTER_CRITICAL(&commandLock);
  left = targetLeft;
  right = targetRight;
  fresh = hasCommand && now - lastCommandAt <= kCommandTimeoutMs;
  portEXIT_CRITICAL(&commandLock);

  if (fresh || (left == 0 && right == 0)) {
    watchdogStopped = false;
    applySpeeds(left, right);
  } else {
    // Commands stopped arriving while the motors were meant to be running.
    if (!watchdogStopped) Serial.println("No drive command for 500 ms, stopping");
    watchdogStopped = true;
    applySpeeds(0, 0);
  }

  static bool wasConnected = false;
  if (connected != wasConnected) {
    wasConnected = connected;
    Serial.println(connected ? "Phone connected" : "Phone disconnected, motors stopped");
  }

  if (restartAdvertising) {
    restartAdvertising = false;
    delay(100);  // let the stack finish tearing down the old connection
    BLEDevice::startAdvertising();
  }

  static uint32_t lastTelemetryAt = 0;
  if (connected && now - lastTelemetryAt >= kTelemetryIntervalMs) {
    lastTelemetryAt = now;
    sendTelemetry();
  }

  // Solid while connected, slow blink while waiting for the phone.
  digitalWrite(kStatusLedPin, connected || (now / 500) % 2 ? HIGH : LOW);
  delay(10);
}
