; Standalone NROM receiver test. Does not include or modify the Battletoads ROM.
; Byte order in expected.bin is raw R08: A=$80 through Right=$01.
; $40: 0=waiting, 1=running, 2=pass, 3=fail. No resync after marker found.
.setcpu "6502"
state = $40
ptr = $41
index = $43                 ; zero-based index in checked sequence (incl marker)
waits = $45                 ; polls before synchronization marker
expected1 = $47
expected2 = $48
vblank_count = $49
.segment "CODE"
reset:
  sei
  cld
  ldx #$40
  stx $4017
  ldx #$FF
  txs
  inx
  stx $2000
  stx $2001
  stx $4010
  stx $4015
  bit $2002
@v1:
  bit $2002
  bpl @v1
  lda #0
@clear:
  sta $0000,x
  sta $0100,x
  sta $0200,x
  sta $0300,x
  sta $0400,x
  sta $0500,x
  sta $0600,x
  sta $0700,x
  inx
  bne @clear
@v2:
  bit $2002
  bpl @v2
  ; A third observed vblank tolerates an initial power-on status flag.
@v3:
  bit $2002
  bpl @v3
  ; Hide sprites; OAM DMA is performed before each controller poll.
  lda #$FF
@oam:
  sta $0200,x
  inx
  bne @oam
  lda #$20
  sta $2006
  lda #0
  sta $2006
  ldx #4
  ldy #0
@nametable:
  sta $2007
  iny
  bne @nametable
  dex
  bne @nametable
  lda #$3F
  sta $2006
  lda #0
  sta $2006
  ldx #0
@palette:
  lda palette,x
  sta $2007
  inx
  cpx #32
  bne @palette
  lda #<screen
  sta ptr
  lda #>screen
  sta ptr+1
  ldy #0
@text:
  lda (ptr),y
  beq @textdone
  sta $2006
  iny
  lda (ptr),y
  sta $2006
  iny
@chars:
  lda (ptr),y
  iny
  cmp #$FF
  beq @text
  sta $2007
  bne @chars              ; strings contain no tile 0
@textdone:
  lda #<samples
  sta ptr
  lda #>samples
  sta ptr+1
  jsr scroll
  lda #$0A
  sta $2001
main:
  lda vblank_count
@vblank:
  cmp vblank_count
  beq @vblank
  jsr display
  jsr scroll
  lda state
  cmp #2
  bcs main               ; Freeze first failure or pass; no further strobes.
  lda #2
  sta $4014              ; Sprite DMA as in a typical game frame (DMC off).
  ; Vary poll location within a frame; never change the serial-read loop.
  ldx index
@jitter:
  dex
  bne @jitter
  jsr poll
  lda state
  bne check
  inc waits
  bne :+
  inc waits+1
:
  lda $15
  cmp samples
  bne main
  lda $16
  cmp samples+1
  bne main
  dec waits              ; Exclude the matching marker poll from prefix count.
  lda waits
  cmp #$FF
  bne :+
  dec waits+1
:
  inc state
check:
  ldy #0
  lda (ptr),y
  sta expected1
  iny
  lda (ptr),y
  sta expected2
  lda $15
  cmp expected1
  bne fail
  lda $16
  cmp expected2
  bne fail
  inc index
  bne :+
  inc index+1
:
  clc
  lda ptr
  adc #2
  sta ptr
  bcc :+
  inc ptr+1
:
  lda index
  cmp #<SAMPLE_COUNT
  bne main
  lda index+1
  cmp #>SAMPLE_COUNT
  bne main
  lda #2
  sta state
  jmp main
fail:
  lda #3
  sta state
  jmp main
scroll:
  lda #$80
  sta $2000
  lda #0
  sta $2005
  sta $2005
  rts
; All writes below fit inside vblank. Hex values are raw received R08 bytes.
display:
  lda #$20
  sta $2006
  lda #$E8
  sta $2006
  lda state
  asl a
  asl a
  tax
  ldy #4
@status:
  lda statuses,x
  sta $2007
  inx
  dey
  bne @status
  lda #$21
  sta $2006
  lda #$48
  sta $2006
  lda index+1
  jsr hex
  lda index
  jsr hex
  lda #$21
  sta $2006
  lda #$A8
  sta $2006
  lda expected1
  jsr hex
  lda #$20
  sta $2007
  lda expected2
  jsr hex
  lda #$21
  sta $2006
  lda #$E8
  sta $2006
  lda $15
  jsr hex
  lda #$20
  sta $2007
  lda $16
  jsr hex
  lda #$22
  sta $2006
  lda #$48
  sta $2006
  lda waits+1
  jsr hex
  lda waits
  jsr hex
  rts
hex:
  pha
  lsr a
  lsr a
  lsr a
  lsr a
  tax
  lda digits,x
  sta $2007
  pla
  and #$0F
  tax
  lda digits,x
  sta $2007
  rts
nmi:
  inc vblank_count
irq:
  rti
palette:
  .byte $0F,$30,$30,$30,$0F,$30,$30,$30,$0F,$30,$30,$30,$0F,$30,$30,$30
  .byte $0F,$30,$30,$30,$0F,$30,$30,$30,$0F,$30,$30,$30,$0F,$30,$30,$30
statuses: .byte "WAITRUN PASSFAIL"
digits: .byte "0123456789ABCDEF"
screen:
  .byte $20,$64,"TASDECK INPUT TEST",$FF
  .byte $20,$A4,"BATTLETOADS READ TIMING",$FF
  .byte $20,$E2,"STATE",$FF
  .byte $21,$42,"INDEX",$FF
  .byte $21,$84,"P1 P2",$FF
  .byte $21,$A2,"WANT",$FF
  .byte $21,$E2,"GOT",$FF
  .byte $22,$42,"PRE",$FF
  .byte $22,$A2,"HEX VALUES - FIRST ERROR",$FF
  .byte $22,$E2,"PASS TARGET 2004",$FF
  .byte $23,$22,"TWO PORTS - STROBE MODE",$FF
  .byte 0
.segment "POLL"
; Exact instruction bytes and placement from the game's $8D78-$8D91 loop.
poll:
  ldx #1
  stx $4016
  dex
  stx $4016
  ldx #8
@bit:
  lda $4016
  ror a
  rol $15
  lda $4017
  ror a
  rol $16
  dex
  bne @bit
  rts
.assert poll = $8D78, lderror, "controller loop moved"
.segment "DATA"
samples:
  .incbin "expected.bin"
SAMPLE_COUNT = (* - samples) / 2
.assert SAMPLE_COUNT = $2004, error, "update pass target label"
.segment "VECTORS"
.word nmi, reset, irq
