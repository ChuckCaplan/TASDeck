#include "NesDeckProtocol.h"

#include <ctype.h>
#include <string.h>

namespace tasdeck {
namespace {

constexpr size_t kMaxLineLength = 287;
constexpr size_t kMaxTokens = 6;

struct Tokens {
  char* values[kMaxTokens] = {};
  size_t count = 0;
};

bool equalsIgnoreCase(const char* left, const char* right) {
  if (left == nullptr || right == nullptr) {
    return false;
  }

  while (*left != '\0' && *right != '\0') {
    const unsigned char leftChar = static_cast<unsigned char>(*left);
    const unsigned char rightChar = static_cast<unsigned char>(*right);
    if (tolower(leftChar) != tolower(rightChar)) {
      return false;
    }

    ++left;
    ++right;
  }

  return *left == '\0' && *right == '\0';
}

size_t boundedStringLength(const char* value, size_t maxLength) {
  size_t length = 0;
  while (length <= maxLength && value[length] != '\0') {
    length += 1;
  }

  return length;
}

bool tokenize(const char* line, char* buffer, size_t bufferLength, Tokens& tokens) {
  if (line == nullptr || bufferLength == 0) {
    return false;
  }

  const size_t lineLength = boundedStringLength(line, kMaxLineLength + 1);
  if (lineLength == 0 || lineLength > kMaxLineLength || lineLength >= bufferLength) {
    return false;
  }

  memcpy(buffer, line, lineLength);
  buffer[lineLength] = '\0';

  char* token = strtok(buffer, " \t\r\n");
  while (token != nullptr) {
    if (tokens.count >= kMaxTokens) {
      return false;
    }

    tokens.values[tokens.count] = token;
    tokens.count += 1;
    token = strtok(nullptr, " \t\r\n");
  }

  return tokens.count > 0;
}

Button parseButton(const char* token) {
  if (equalsIgnoreCase(token, "a")) {
    return Button::A;
  }
  if (equalsIgnoreCase(token, "b")) {
    return Button::B;
  }
  if (equalsIgnoreCase(token, "select") || equalsIgnoreCase(token, "sel")) {
    return Button::Select;
  }
  if (equalsIgnoreCase(token, "start") || equalsIgnoreCase(token, "s")) {
    return Button::Start;
  }
  if (equalsIgnoreCase(token, "up") || equalsIgnoreCase(token, "u")) {
    return Button::Up;
  }
  if (equalsIgnoreCase(token, "down") || equalsIgnoreCase(token, "d")) {
    return Button::Down;
  }
  if (equalsIgnoreCase(token, "left") || equalsIgnoreCase(token, "l")) {
    return Button::Left;
  }
  if (equalsIgnoreCase(token, "right") || equalsIgnoreCase(token, "r")) {
    return Button::Right;
  }

  return Button::Unknown;
}

Action parseAction(const char* token) {
  if (equalsIgnoreCase(token, "down") || equalsIgnoreCase(token, "press")) {
    return Action::Down;
  }
  if (equalsIgnoreCase(token, "up") || equalsIgnoreCase(token, "release")) {
    return Action::Up;
  }

  return Action::Unknown;
}

TasSyncMode parseTasSyncMode(const char* token) {
  if (equalsIgnoreCase(token, "poll") || equalsIgnoreCase(token, "latch")) {
    return TasSyncMode::Poll;
  }

  return TasSyncMode::Unknown;
}

bool parseControllerPort(const char* token, uint8_t& port) {
  if (equalsIgnoreCase(token, "1") || equalsIgnoreCase(token, "p1") || equalsIgnoreCase(token, "port1")) {
    port = 1;
    return true;
  }
  if (equalsIgnoreCase(token, "2") || equalsIgnoreCase(token, "p2") || equalsIgnoreCase(token, "port2")) {
    port = 2;
    return true;
  }

  return false;
}

bool parseUnsigned(const char* token, uint32_t& value) {
  if (token == nullptr || *token == '\0') {
    return false;
  }

  uint32_t parsed = 0;
  while (*token != '\0') {
    const unsigned char character = static_cast<unsigned char>(*token);
    if (!isdigit(character)) {
      return false;
    }

    const uint32_t digit = static_cast<uint32_t>(*token - '0');
    if (parsed > (UINT32_MAX - digit) / 10) {
      return false;
    }

    parsed = parsed * 10 + digit;
    ++token;
  }

  value = parsed;
  return true;
}

int parseHexDigit(char character) {
  if (character >= '0' && character <= '9') {
    return character - '0';
  }
  if (character >= 'a' && character <= 'f') {
    return character - 'a' + 10;
  }
  if (character >= 'A' && character <= 'F') {
    return character - 'A' + 10;
  }

  return -1;
}

bool parseHexByte(const char* token, uint8_t& value) {
  if (token == nullptr || token[0] == '\0' || token[1] == '\0' || token[2] != '\0') {
    return false;
  }

  const int high = parseHexDigit(token[0]);
  const int low = parseHexDigit(token[1]);
  if (high < 0 || low < 0) {
    return false;
  }

  value = static_cast<uint8_t>((high << 4) | low);
  return true;
}

bool parseEncodedMasks(const char* token, uint8_t count, uint8_t portCount, TasFrameMasks* masks) {
  if (
    token == nullptr ||
    masks == nullptr ||
    count == 0 ||
    count > kTasChunkFrameLimit ||
    portCount == 0 ||
    portCount > kNesControllerPortCount) {
    return false;
  }

  const size_t expectedLength = static_cast<size_t>(count) * static_cast<size_t>(portCount) * 2;
  if (strlen(token) != expectedLength) {
    return false;
  }

  for (uint8_t frameIndex = 0; frameIndex < count; ++frameIndex) {
    masks[frameIndex] = TasFrameMasks{};
    for (uint8_t portIndex = 0; portIndex < portCount; ++portIndex) {
      const size_t offset = (static_cast<size_t>(frameIndex) * portCount + portIndex) * 2;
      const int high = parseHexDigit(token[offset]);
      const int low = parseHexDigit(token[offset + 1]);
      if (high < 0 || low < 0) {
        return false;
      }

      const uint8_t value = static_cast<uint8_t>((high << 4) | low);
      if (portIndex == 0) {
        masks[frameIndex].port1 = value;
      } else {
        masks[frameIndex].port2 = value;
      }
    }
  }

  return true;
}

bool parseButtonCommand(const Tokens& tokens, Command& command) {
  if (tokens.count != 3 && tokens.count != 4) {
    return false;
  }

  uint8_t controllerPort = 1;
  const size_t buttonIndex = tokens.count == 4 ? 2 : 1;
  const size_t actionIndex = tokens.count == 4 ? 3 : 2;
  if (tokens.count == 4 && !parseControllerPort(tokens.values[1], controllerPort)) {
    return false;
  }

  const Button button = parseButton(tokens.values[buttonIndex]);
  const Action action = parseAction(tokens.values[actionIndex]);
  if (button == Button::Unknown || action == Action::Unknown) {
    return false;
  }

  command.type = CommandType::Button;
  command.controllerPort = controllerPort;
  command.button = button;
  command.action = action;
  return true;
}

bool parseTasBeginCommand(const Tokens& tokens, Command& command) {
  if (tokens.count < 3 || tokens.count > 5) {
    return false;
  }

  uint32_t frameCount = 0;
  if (!parseUnsigned(tokens.values[1], frameCount) || frameCount == 0) {
    return false;
  }

  const TasSyncMode syncMode = parseTasSyncMode(tokens.values[2]);
  if (syncMode == TasSyncMode::Unknown) {
    return false;
  }

  uint8_t portCount = 1;
  uint32_t latchWindowMicros = kTasDefaultLatchWindowMicros;
  if (tokens.count == 4) {
    uint32_t parsed = 0;
    if (!parseUnsigned(tokens.values[3], parsed)) {
      return false;
    }

    // The optional 4th token is dispatched by value range: a port count or a
    // latch window override. The ranges must never overlap or an old command
    // would be silently reinterpreted when either bound moves.
    static_assert(
      kTasMinLatchWindowMicros > kNesControllerPortCount,
      "TAS_BEGIN port-count and window_us token ranges must stay disjoint");
    if (parsed >= 1 && parsed <= kNesControllerPortCount) {
      portCount = static_cast<uint8_t>(parsed);
    } else if (parsed >= kTasMinLatchWindowMicros && parsed <= kTasMaxLatchWindowMicros) {
      latchWindowMicros = parsed;
    } else {
      return false;
    }
  } else if (tokens.count == 5) {
    uint32_t parsedPortCount = 0;
    if (
      !parseUnsigned(tokens.values[3], parsedPortCount) ||
      parsedPortCount == 0 ||
      parsedPortCount > kNesControllerPortCount ||
      !parseUnsigned(tokens.values[4], latchWindowMicros) ||
      latchWindowMicros < kTasMinLatchWindowMicros ||
      latchWindowMicros > kTasMaxLatchWindowMicros) {
      return false;
    }
    portCount = static_cast<uint8_t>(parsedPortCount);
  }

  command.type = CommandType::TasBegin;
  command.frameCount = frameCount;
  command.portCount = portCount;
  command.syncMode = syncMode;
  command.latchWindowMicros = latchWindowMicros;
  return true;
}

bool parseTasChunkCommand(const Tokens& tokens, Command& command) {
  if (tokens.count != 5 && tokens.count != 6) {
    return false;
  }

  uint32_t startIndex = 0;
  uint32_t countValue = 0;
  uint32_t portCountValue = 1;
  uint8_t checksum = 0;
  const size_t encodedIndex = tokens.count == 6 ? 4 : 3;
  const size_t checksumIndex = tokens.count == 6 ? 5 : 4;
  if (
    !parseUnsigned(tokens.values[1], startIndex) ||
    !parseUnsigned(tokens.values[2], countValue) ||
    countValue == 0 ||
    countValue > kTasChunkFrameLimit) {
    return false;
  }

  if (
    tokens.count == 6 &&
    (!parseUnsigned(tokens.values[3], portCountValue) ||
      portCountValue == 0 ||
      portCountValue > kNesControllerPortCount)) {
    return false;
  }

  if (
    !parseEncodedMasks(
      tokens.values[encodedIndex],
      static_cast<uint8_t>(countValue),
      static_cast<uint8_t>(portCountValue),
      command.masks) ||
    !parseHexByte(tokens.values[checksumIndex], checksum)) {
    return false;
  }

  const uint8_t count = static_cast<uint8_t>(countValue);
  const uint8_t portCount = static_cast<uint8_t>(portCountValue);
  if (tasChunkChecksum(startIndex, command.masks, count, portCount) != checksum) {
    return false;
  }

  command.type = CommandType::TasChunk;
  command.startIndex = startIndex;
  command.portCount = portCount;
  command.chunkCount = count;
  command.checksum = checksum;
  return true;
}

bool parseTasTraceCommand(const Tokens& tokens, Command& command) {
  if (tokens.count > 3) {
    return false;
  }

  uint32_t count = kTasTracePageLimit;
  uint32_t start = 0;
  if (tokens.count >= 2 && (!parseUnsigned(tokens.values[1], count) || count == 0 || count > kTasTracePageLimit)) {
    return false;
  }
  if (tokens.count == 3 && !parseUnsigned(tokens.values[2], start)) {
    return false;
  }

  command.type = CommandType::TasTrace;
  command.traceCount = static_cast<uint8_t>(count);
  command.traceStart = start;
  command.traceHasStart = tokens.count == 3;
  return true;
}

}  // namespace

uint8_t tasChunkChecksum(uint32_t startIndex, const uint8_t* masks, uint8_t count) {
  TasFrameMasks frameMasks[kTasChunkFrameLimit] = {};
  if (masks == nullptr || count > kTasChunkFrameLimit) {
    return 0;
  }

  for (uint8_t index = 0; index < count; ++index) {
    frameMasks[index].port1 = masks[index];
  }

  return tasChunkChecksum(startIndex, frameMasks, count, 1);
}

uint8_t tasChunkChecksum(uint32_t startIndex, const TasFrameMasks* masks, uint8_t count, uint8_t portCount) {
  uint8_t checksum = 0;
  checksum = static_cast<uint8_t>(checksum ^ (startIndex & 0xff));
  checksum = static_cast<uint8_t>(checksum ^ ((startIndex >> 8) & 0xff));
  checksum = static_cast<uint8_t>(checksum ^ ((startIndex >> 16) & 0xff));
  checksum = static_cast<uint8_t>(checksum ^ ((startIndex >> 24) & 0xff));
  checksum = static_cast<uint8_t>(checksum ^ count);
  if (portCount >= kNesControllerPortCount) {
    checksum = static_cast<uint8_t>(checksum ^ kNesControllerPortCount);
  }

  for (uint8_t index = 0; index < count; ++index) {
    checksum = static_cast<uint8_t>(checksum ^ masks[index].port1);
    if (portCount >= kNesControllerPortCount) {
      checksum = static_cast<uint8_t>(checksum ^ masks[index].port2);
    }
  }

  return checksum;
}

bool parseCommand(const char* line, Command& command) {
  command = Command{};

  char buffer[kMaxLineLength + 1] = {};
  Tokens tokens;
  if (!tokenize(line, buffer, sizeof(buffer), tokens)) {
    return false;
  }

  if (equalsIgnoreCase(tokens.values[0], "ping")) {
    if (tokens.count != 1) {
      return false;
    }

    command.type = CommandType::Ping;
    return true;
  }

  if (equalsIgnoreCase(tokens.values[0], "status")) {
    if (tokens.count != 1) {
      return false;
    }

    command.type = CommandType::Status;
    return true;
  }

  if (equalsIgnoreCase(tokens.values[0], "button") || equalsIgnoreCase(tokens.values[0], "btn")) {
    return parseButtonCommand(tokens, command);
  }

  if (equalsIgnoreCase(tokens.values[0], "tas_begin")) {
    return parseTasBeginCommand(tokens, command);
  }

  if (equalsIgnoreCase(tokens.values[0], "tas_chunk")) {
    return parseTasChunkCommand(tokens, command);
  }

  if (equalsIgnoreCase(tokens.values[0], "tas_start")) {
    if (tokens.count != 1 && tokens.count != 2) {
      return false;
    }

    uint32_t startDelayPolls = 0;
    if (
      tokens.count == 2 &&
      (!parseUnsigned(tokens.values[1], startDelayPolls) || startDelayPolls > kTasMaxStartDelayPolls)) {
      return false;
    }

    command.type = CommandType::TasStart;
    command.startDelayPolls = startDelayPolls;
    return true;
  }

  if (equalsIgnoreCase(tokens.values[0], "tas_cancel")) {
    if (tokens.count != 1) {
      return false;
    }

    command.type = CommandType::TasCancel;
    return true;
  }

  if (equalsIgnoreCase(tokens.values[0], "tas_end")) {
    if (tokens.count != 1) {
      return false;
    }

    command.type = CommandType::TasEnd;
    return true;
  }

  if (equalsIgnoreCase(tokens.values[0], "tas_status")) {
    if (tokens.count != 1) {
      return false;
    }

    command.type = CommandType::TasStatus;
    return true;
  }

  if (equalsIgnoreCase(tokens.values[0], "tas_trace_resume")) {
    if (tokens.count != 1) {
      return false;
    }

    command.type = CommandType::TasTraceResume;
    return true;
  }

  if (equalsIgnoreCase(tokens.values[0], "tas_trace")) {
    return parseTasTraceCommand(tokens, command);
  }

  return false;
}

const char* commandTypeName(CommandType type) {
  switch (type) {
    case CommandType::Ping:
      return "ping";
    case CommandType::Status:
      return "status";
    case CommandType::Button:
      return "button";
    case CommandType::TasBegin:
      return "tas_begin";
    case CommandType::TasChunk:
      return "tas_chunk";
    case CommandType::TasStart:
      return "tas_start";
    case CommandType::TasCancel:
      return "tas_cancel";
    case CommandType::TasEnd:
      return "tas_end";
    case CommandType::TasStatus:
      return "tas_status";
    case CommandType::TasTrace:
      return "tas_trace";
    case CommandType::TasTraceResume:
      return "tas_trace_resume";
    case CommandType::Invalid:
    default:
      return "invalid";
  }
}

const char* buttonName(Button button) {
  switch (button) {
    case Button::A:
      return "a";
    case Button::B:
      return "b";
    case Button::Select:
      return "select";
    case Button::Start:
      return "start";
    case Button::Up:
      return "up";
    case Button::Down:
      return "down";
    case Button::Left:
      return "left";
    case Button::Right:
      return "right";
    case Button::Unknown:
    default:
      return "unknown";
  }
}

const char* actionName(Action action) {
  switch (action) {
    case Action::Down:
      return "down";
    case Action::Up:
      return "up";
    case Action::Unknown:
    default:
      return "unknown";
  }
}

const char* tasSyncModeName(TasSyncMode syncMode) {
  switch (syncMode) {
    case TasSyncMode::Poll:
      return "poll";
    case TasSyncMode::Unknown:
    default:
      return "unknown";
  }
}

}  // namespace tasdeck
