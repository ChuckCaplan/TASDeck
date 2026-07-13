#ifndef TASDECK_NES_DECK_PROTOCOL_H
#define TASDECK_NES_DECK_PROTOCOL_H

#include <stddef.h>
#include <stdint.h>

namespace tasdeck {

constexpr uint8_t kNesControllerPortCount = 2;
constexpr uint8_t kTasChunkFrameLimit = 48;
constexpr uint32_t kTasMaxStartDelayPolls = 3600;
constexpr uint8_t kTasTracePageLimit = 12;
// Latch edges closer together than the window are the same console frame.
// Default mirrors VeriTAS's 8ms latch filter: comfortably longer than any
// same-frame re-read burst, comfortably shorter than one NTSC frame (16.6ms).
constexpr uint32_t kTasDefaultLatchWindowMicros = 8000;
constexpr uint32_t kTasMinLatchWindowMicros = 500;
constexpr uint32_t kTasMaxLatchWindowMicros = 15000;

enum class CommandType {
  Invalid,
  Ping,
  Status,
  Button,
  TasBegin,
  TasChunk,
  TasStart,
  TasCancel,
  TasEnd,
  TasStatus,
  TasTrace,
  TasTraceResume,
};

enum class Button {
  Unknown,
  A,
  B,
  Select,
  Start,
  Up,
  Down,
  Left,
  Right,
};

enum class Action {
  Unknown,
  Down,
  Up,
};

enum class TasSyncMode {
  Unknown,
  Poll,
  Latch,
};

struct TasFrameMasks {
  uint8_t port1 = 0;
  uint8_t port2 = 0;
};

struct Command {
  CommandType type = CommandType::Invalid;
  uint8_t controllerPort = 1;
  Button button = Button::Unknown;
  Action action = Action::Unknown;
  uint32_t frameCount = 0;
  uint8_t portCount = 1;
  TasSyncMode syncMode = TasSyncMode::Unknown;
  uint32_t latchWindowMicros = kTasDefaultLatchWindowMicros;
  uint32_t startIndex = 0;
  uint8_t chunkCount = 0;
  TasFrameMasks masks[kTasChunkFrameLimit] = {};
  uint8_t checksum = 0;
  uint32_t startDelayPolls = 0;
  uint8_t traceCount = kTasTracePageLimit;
  uint32_t traceStart = 0;
  bool traceHasStart = false;
};

bool parseCommand(const char* line, Command& command);
uint8_t tasChunkChecksum(uint32_t startIndex, const uint8_t* masks, uint8_t count);
uint8_t tasChunkChecksum(uint32_t startIndex, const TasFrameMasks* masks, uint8_t count, uint8_t portCount);

const char* commandTypeName(CommandType type);
const char* buttonName(Button button);
const char* actionName(Action action);
const char* tasSyncModeName(TasSyncMode syncMode);

}  // namespace tasdeck

#endif
