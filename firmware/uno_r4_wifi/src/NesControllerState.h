#ifndef TASDECK_NES_CONTROLLER_STATE_H
#define TASDECK_NES_CONTROLLER_STATE_H

#include <stdint.h>

#include "NesDeckProtocol.h"

namespace tasdeck {

constexpr uint8_t kNesButtonCount = 8;

class NesControllerState {
 public:
  bool applyCommand(const Command& command);
  bool setButton(Button button, bool pressed);
  void latch();
  void advance();
  bool dataLineHigh() const;
  uint8_t pressedMask() const;
  uint8_t latchedMask() const;
  uint8_t shiftIndex() const;
  void releaseAll();

 private:
  uint8_t pressed_ = 0;
  uint8_t latched_ = 0;
  uint8_t shiftIndex_ = 0;
};

struct NesControllerDataLevels {
  bool port1High = true;
  bool port2High = true;
};

uint8_t buttonMask(Button button);
NesControllerDataLevels firstDataLineLevels(TasFrameMasks masks);

}  // namespace tasdeck

#endif
