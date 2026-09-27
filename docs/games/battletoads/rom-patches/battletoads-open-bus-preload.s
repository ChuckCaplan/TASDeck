; Battletoads startup patch v2: EverDrive N8 Pro open-bus preload.
; A real AxROM cartridge leaves $6000-7FFF as open bus. The N8 Pro drives save RAM
; there on every read (edn8-pro-pub fpga/000/map_007.sv), which changes the level 3
; loader's out-of-table reads and breaks the game-end glitch's slide to $8000.
; Fill that RAM with the bytes open bus produces in these movies. On a real
; cartridge the writes go nowhere.
;
; Timing: the hook runs with NMI and rendering off, where 3 NTSC frames are exactly
; 89342 CPU cycles. The whole detour is padded to exactly 6 frames (178684 cycles
; more than the displaced LDA #0 / LDX #$17), so the original reset continues at the
; same PPU dot, CPU cycle parity, and odd/even frame as the unmodified ROM.
.setcpu "6502"
.export stub, preload

previous_bankID = $2D
bank_call       = $FFCB           ; same helper in every bank

; Bank 6 padding, reached from jump-table entry $802A via the bank-0 reset trampoline.
.segment "STUB"
stub:
 ldx #<preload                    ; bank 7's $8000 does JMP ($0013); $14 is already $80
 ldy #7
 jsr bank_call
 lda #0                           ; the nested call replaced bank 0's return bank
 sta previous_bankID
 rts

; Bank 7 padding. $80BB is still read as table data by $8550/$85B3, so start after it.
.segment "PRELOAD"
preload:
 ; Each address holds its page byte, as for open-bus reads after an absolute operand:
 ; $66EB-$66EF read $66 and the level 3 loader's $7FEB-$7FFF reads $7F.
 ldy #0
 sty $00
 lda #$60
page:
 sta $01
fill:
 sta ($00),y
 iny
 bne fill
 inc $01
 lda $01
 bpl page
 ; The game-end glitch executes from $75BD: $75 $75 (ADC $75,X) leaves $6F on the bus,
 ; then RRA $6F6F repeats through $7FEA and ends exactly at $8000.
 lda #$75
 sta $01
 ldy #$BF
 lda #$6F
slide:
 sta ($00),y
 iny
 bne slide
 inc $01
 ldx $01
 cpx #$7F
 bne slide
slide_tail:
 sta ($00),y
 iny
 cpy #$EB
 bne slide_tail
 ; The detour through here measures 119956 cycles before this delay. 225 * (5 * 51 + 6)
 ; + 1 + 2 = 58728 more makes 178684. Changing any instruction above changes that count.
 ldx #225
delay_outer:
 ldy #51
delay_inner:
 dey
 bne delay_inner
 dex
 bne delay_outer
 nop
 rts
preload_end:

.assert >preload = $80, error, "bank-call dispatch reaches only $8000-$80FF"
.assert >preload_end = $80, error, "preload must stay in one page for fixed branch timing"
