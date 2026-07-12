#include "NesControllerState.h"

namespace tasdeck {

uint8_t buttonMask(Button button) {
  switch (button) {
    case Button::A:
      return 0x01;
    case Button::B:
      return 0x02;
    case Button::Select:
      return 0x04;
    case Button::Start:
      return 0x08;
    case Button::Up:
      return 0x10;
    case Button::Down:
      return 0x20;
    case Button::Left:
      return 0x40;
    case Button::Right:
      return 0x80;
    case Button::Unknown:
    default:
      return 0;
  }
}

NesControllerDataLevels firstDataLineLevels(TasFrameMasks masks) {
  NesControllerDataLevels levels;
  levels.port1High = (masks.port1 & 0x01) == 0;
  levels.port2High = (masks.port2 & 0x01) == 0;
  return levels;
}

bool NesControllerState::applyCommand(const Command& command) {
  if (command.type != CommandType::Button) {
    return false;
  }

  return setButton(command.button, command.action == Action::Down);
}

bool NesControllerState::setButton(Button button, bool pressed) {
  const uint8_t mask = buttonMask(button);
  if (mask == 0) {
    return false;
  }

  if (pressed) {
    pressed_ = static_cast<uint8_t>(pressed_ | mask);
  } else {
    pressed_ = static_cast<uint8_t>(pressed_ & ~mask);
  }

  return true;
}

void NesControllerState::latch() {
  latched_ = pressed_;
  shiftIndex_ = 0;
}

void NesControllerState::advance() {
  if (shiftIndex_ < kNesButtonCount) {
    shiftIndex_ += 1;
  }
}

bool NesControllerState::dataLineHigh() const {
  if (shiftIndex_ >= kNesButtonCount) {
    return true;
  }

  const uint8_t mask = static_cast<uint8_t>(1 << shiftIndex_);
  return (latched_ & mask) == 0;
}

uint8_t NesControllerState::pressedMask() const {
  return pressed_;
}

uint8_t NesControllerState::latchedMask() const {
  return latched_;
}

uint8_t NesControllerState::shiftIndex() const {
  return shiftIndex_;
}

void NesControllerState::releaseAll() {
  pressed_ = 0;
  latched_ = 0;
  shiftIndex_ = 0;
}

}  // namespace tasdeck
